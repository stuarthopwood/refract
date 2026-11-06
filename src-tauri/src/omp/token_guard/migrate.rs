// One-time move of Refract's token guard from `token-guard.json` + overlay to the global omp config.
// The marker is written only after the backup and every write succeeded, so a failure retries on the next launch.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{legacy, values};
use crate::omp::advisor_roster::agent_dir;
use crate::omp::config::set_config;
use crate::store::atomic_json::write_json_file;

const MARKER_FILE: &str = "token-guard-migration.json";
const RETIRED_SUFFIX: &str = ".migrated";

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Marker {
    backup_path: Option<String>,
    #[serde(default)]
    notice_dismissed: bool,
}

/// What `tokenGuard.get` reports as `migration`.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
}

static RUN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

fn marker_path(dir: &Path) -> PathBuf {
    dir.join(MARKER_FILE)
}

async fn read_marker(dir: &Path) -> Option<Marker> {
    let bytes = tokio::fs::read(marker_path(dir)).await.ok()?;
    Some(serde_json::from_slice(&bytes).unwrap_or_default())
}

/// `YYYY-MM-DD` (UTC) from a Unix timestamp, by the days-to-civil algorithm.
fn date_string(unix_secs: u64) -> String {
    let z = (unix_secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

pub async fn is_done(dir: &Path) -> bool {
    read_marker(dir).await.is_some()
}

fn today() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    date_string(secs)
}

/// `config.yml.refract-backup-<date>`, with `-2`, `-3`... on a name collision; never overwrites.
fn backup_path(config: &Path, date: &str, taken: impl Fn(&Path) -> bool) -> PathBuf {
    let base = format!("{}.refract-backup-{date}", config.display());
    let first = PathBuf::from(&base);
    if !taken(&first) {
        return first;
    }
    (2u32..)
        .map(|n| PathBuf::from(format!("{base}-{n}")))
        .find(|p| !taken(p))
        .expect("an unbounded counter always finds a free name")
}

/// Backs up, writes Refract's set with the user's `token-guard.json` choices on top, then marks done and retires the file.
async fn attempt<W, F>(
    dir: &Path,
    config: Option<&Path>,
    date: &str,
    write: W,
) -> Result<(), String>
where
    W: Fn(String, Value) -> F,
    F: Future<Output = Result<(), String>>,
{
    let mut backup = None;
    if let Some(config) = config.filter(|c| c.is_file()) {
        let target = backup_path(config, date, |p| p.exists());
        tokio::fs::copy(config, &target)
            .await
            .map_err(|err| format!("Could not back up the omp config: {err}"))?;
        backup = Some(target.to_string_lossy().into_owned());
    }
    let mut wanted = legacy::effective(dir).await;
    // A positive thresholdTokens would beat the percent, so Refract pins it off.
    wanted.insert("compaction.thresholdTokens".to_string(), json!(-1));
    for (key, value) in wanted {
        write(key.clone(), value)
            .await
            .map_err(|err| format!("Could not write {key}: {err}"))?;
    }
    let marker = Marker {
        backup_path: backup,
        notice_dismissed: false,
    };
    write_json_file(&marker_path(dir), &marker)
        .await
        .map_err(|err| format!("Could not record the migration: {err}"))?;
    // The marker already makes the file inert; a failed rename only leaves it behind.
    let old = legacy::path(dir);
    let mut retired = old.clone().into_os_string();
    retired.push(RETIRED_SUFFIX);
    if let Err(err) = tokio::fs::rename(&old, PathBuf::from(retired)).await {
        if err.kind() != std::io::ErrorKind::NotFound {
            log::warn!("token guard: could not retire token-guard.json: {err}");
        }
    }
    Ok(())
}

async fn write_to_omp(key: String, value: Value) -> Result<(), String> {
    if key == "compaction.thresholdTokens" {
        return set_config(&key, &value, &[])
            .await
            .map(|_| ())
            .map_err(|err| err.message);
    }
    values::write_key(&key, &value).await
}

/// True once the global config holds the token guard set. Runs the migration if it has not yet succeeded; a failure is retried on the next call.
pub async fn ensure(dir: &Path) -> bool {
    let _guard = RUN_LOCK.lock().await;
    if read_marker(dir).await.is_some() {
        return true;
    }
    let config = agent_dir().map(|d| d.join("config.yml"));
    match attempt(dir, config.as_deref(), &today(), write_to_omp).await {
        Ok(()) => {
            *LAST_ERROR.lock().expect("poisoned") = None;
            true
        }
        Err(err) => {
            log::warn!("token guard migration failed: {err}");
            *LAST_ERROR.lock().expect("poisoned") = Some(err);
            false
        }
    }
}

pub async fn status(dir: &Path) -> Status {
    if let Some(marker) = read_marker(dir).await {
        return Status {
            status: "done",
            error: None,
            backup_path: marker.backup_path.filter(|_| !marker.notice_dismissed),
        };
    }
    let error = LAST_ERROR.lock().expect("poisoned").clone();
    Status {
        status: if error.is_some() { "failed" } else { "pending" },
        error,
        backup_path: None,
    }
}

/// Marks the one-line backup notice as shown.
pub async fn dismiss_notice(dir: &Path) -> Result<(), String> {
    let _guard = RUN_LOCK.lock().await;
    let Some(mut marker) = read_marker(dir).await else {
        return Ok(());
    };
    marker.notice_dismissed = true;
    write_json_file(&marker_path(dir), &marker)
        .await
        .map_err(|err| format!("Could not save the migration notice: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn date_is_utc_calendar_day() {
        assert_eq!(date_string(0), "1970-01-01");
        assert_eq!(date_string(1_794_000_000), "2026-11-06");
    }

    #[test]
    fn backup_name_gets_a_suffix_on_collision() {
        let config = Path::new("/a/config.yml");
        let base = "/a/config.yml.refract-backup-2026-11-06";
        assert_eq!(
            backup_path(config, "2026-11-06", |_| false),
            PathBuf::from(base)
        );
        let taken = [base.to_string(), format!("{base}-2")];
        let name = backup_path(config, "2026-11-06", |p| {
            taken.iter().any(|t| Path::new(t) == p)
        });
        assert_eq!(name, PathBuf::from(format!("{base}-3")));
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("refract-mig-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn failure_keeps_the_file_then_a_retry_completes() {
        let dir = scratch("retry");
        let config = dir.join("config.yml");
        std::fs::write(&config, "a: 1\n").unwrap();
        std::fs::write(
            legacy::path(&dir),
            r#"{"version":2,"overrides":{"task.maxConcurrency":3}}"#,
        )
        .unwrap();
        let calls = AtomicUsize::new(0);
        let failing = |_: String, _: Value| {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            async move {
                if n == 2 {
                    Err("boom".to_string())
                } else {
                    Ok(())
                }
            }
        };
        let err = attempt(&dir, Some(&config), "2026-11-06", failing)
            .await
            .unwrap_err();
        assert!(err.contains("boom"));
        assert!(legacy::path(&dir).exists());
        assert!(read_marker(&dir).await.is_none());

        let written = std::sync::Mutex::new(Vec::new());
        let ok = |k: String, v: Value| {
            written.lock().unwrap().push((k, v));
            async { Ok(()) }
        };
        attempt(&dir, Some(&config), "2026-11-06", ok)
            .await
            .unwrap();
        let marker = read_marker(&dir).await.expect("marker");
        assert!(marker
            .backup_path
            .unwrap()
            .ends_with("refract-backup-2026-11-06-2"));
        assert!(!legacy::path(&dir).exists());
        let written = written.lock().unwrap();
        assert!(written.contains(&("task.maxConcurrency".to_string(), json!(3))));
        assert!(written.contains(&("compaction.thresholdTokens".to_string(), json!(-1))));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
