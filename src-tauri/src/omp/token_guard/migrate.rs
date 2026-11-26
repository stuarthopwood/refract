// One-time move of Refract's token guard from `token-guard.json` + overlay to the global omp config.
// The marker is written only after the backup and every write succeeded, so a failure retries on the next launch.

use std::ffi::OsString;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, Once};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{legacy, values};
use crate::omp::advisor_roster::agent_dir;
use crate::omp::config::{list_config_with, set_config_with, OmpExecutor, RealOmpExecutor};
use crate::store::atomic_json::write_json_file;

const MARKER_FILE: &str = "token-guard-migration.json";
const PENDING_FILE: &str = "token-guard-migration-backup.json";
const RETIRED_SUFFIX: &str = ".migrated";
const CACHE_RETENTION_KEY: &str = "providers.cacheRetention";

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Marker {
    backup_path: Option<String>,
    #[serde(default)]
    notice_dismissed: bool,
    /// `providers.cacheRetention: long` joined the token guard after the first migration (#2209).
    #[serde(default)]
    cache_retention_applied: bool,
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
/// Set when this launch has tried the cache retention catch-up, so a failing `omp` costs one read per launch, not one per call.
static CATCH_UP_TRIED: AtomicBool = AtomicBool::new(false);

fn marker_path(dir: &Path) -> PathBuf {
    dir.join(MARKER_FILE)
}

/// A corrupt marker still counts as done: re-running would clobber settings the user may have changed since.
async fn read_marker(dir: &Path) -> Option<Marker> {
    let bytes = tokio::fs::read(marker_path(dir)).await.ok()?;
    Some(serde_json::from_slice(&bytes).unwrap_or_default())
}

fn pending_path(dir: &Path) -> PathBuf {
    dir.join(PENDING_FILE)
}

/// The backup taken by an earlier, unfinished attempt, if its file still exists.
async fn pending_backup(dir: &Path) -> Option<String> {
    let bytes = tokio::fs::read(pending_path(dir)).await.ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    let path = value.get("backupPath")?.as_str()?.to_string();
    Path::new(&path).is_file().then_some(path)
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
    !skipped() && read_marker(dir).await.is_some()
}

/// Debug builds only: a scratch `REFRACT_DATA_DIR` without a scratch `PI_CODING_AGENT_DIR` leaves
/// `agent_dir()` and `omp` on the user's real `~/.omp/agent`.
fn shares_real_agent_dir(
    debug_build: bool,
    data_dir_override: Option<String>,
    agent_dir_override: Option<OsString>,
) -> bool {
    debug_build
        && crate::resolve_data_dir_override(data_dir_override).is_some()
        && agent_dir_override.is_none_or(|dir| dir.is_empty())
}

const SKIPPED_REASON: &str = "Token guard changes are off: REFRACT_DATA_DIR is set without PI_CODING_AGENT_DIR, so the real omp config is left alone";

/// True when this launch could only reach the user's real global config: the migration and every
/// token guard write then stay off, so a scratch launch never backs up or rewrites it.
pub fn skipped() -> bool {
    let skip = shares_real_agent_dir(
        cfg!(debug_assertions),
        std::env::var("REFRACT_DATA_DIR").ok(),
        std::env::var_os("PI_CODING_AGENT_DIR"),
    );
    if skip {
        static NOTED: Once = Once::new();
        NOTED.call_once(|| {
            log::info!(
                "token guard: {SKIPPED_REASON}; skipping the global config migration and writes"
            );
        });
    }
    skip
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
/// A key whose value in `current` (one `omp config list`, `None` when the read failed) already equals the target is not written again.
/// `providers.cacheRetention` is written only over an unset or `auto` value; a failed read leaves it for the next launch's catch-up.
async fn attempt<W, F>(
    dir: &Path,
    current: Option<&Value>,
    config: Option<&Path>,
    date: &str,
    write: W,
) -> Result<(), String>
where
    W: Fn(String, Value) -> F,
    F: Future<Output = Result<(), String>>,
{
    let mut backup = pending_backup(dir).await;
    if backup.is_none() {
        if let Some(config) = config.filter(|c| c.is_file()) {
            let target = backup_path(config, date, |p| p.exists());
            tokio::fs::copy(config, &target)
                .await
                .map_err(|err| format!("Could not back up the omp config: {err}"))?;
            let path = target.to_string_lossy().into_owned();
            // Recorded before any write so a retry reuses the pristine copy.
            write_json_file(&pending_path(dir), &json!({ "backupPath": path }))
                .await
                .map_err(|err| format!("Could not record the backup: {err}"))?;
            backup = Some(path);
        }
    }
    let mut wanted = legacy::effective(dir).await;
    // A positive thresholdTokens would beat the percent, so Refract pins it off.
    wanted.insert("compaction.thresholdTokens".to_string(), json!(-1));
    for (key, value) in wanted {
        if current.and_then(|c| values::raw_value(c, &key)) == Some(&value) {
            continue;
        }
        if key == CACHE_RETENTION_KEY && !current.is_some_and(retention_is_unset) {
            continue;
        }
        write(key.clone(), value)
            .await
            .map_err(|err| format!("Could not write {key}: {err}"))?;
    }
    let marker = Marker {
        backup_path: backup,
        notice_dismissed: false,
        cache_retention_applied: current.is_some(),
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

async fn write_to_omp(
    executor: &dyn OmpExecutor,
    config: Option<&Path>,
    key: String,
    value: Value,
) -> Result<(), String> {
    if key == "compaction.thresholdTokens" {
        return set_config_with(executor, &key, &value, &[])
            .await
            .map(|_| ())
            .map_err(|err| err.message);
    }
    values::write_key(executor, &key, &value, config).await
}

/// True once the global config holds the token guard set. Runs the migration if it has not yet succeeded; a failure is retried on the next call.
pub async fn ensure(dir: &Path) -> bool {
    let config = agent_dir().map(|d| d.join("config.yml"));
    ensure_with(&RealOmpExecutor, dir, config.as_deref()).await
}

/// `ensure` through an injected `omp` executor; `config` is the file the backup copies.
pub async fn ensure_with(executor: &dyn OmpExecutor, dir: &Path, config: Option<&Path>) -> bool {
    ensure_once_per_launch(executor, dir, config, &CATCH_UP_TRIED).await
}

/// `ensure_with` with the once-per-launch catch-up flag injected, so tests do not share the process-wide one.
async fn ensure_once_per_launch(
    executor: &dyn OmpExecutor,
    dir: &Path,
    config: Option<&Path>,
    catch_up_tried: &AtomicBool,
) -> bool {
    if skipped() {
        return false;
    }
    let _guard = RUN_LOCK.lock().await;
    if let Some(marker) = read_marker(dir).await {
        // Tried even when it fails: the flag stays unset on disk, so the next launch retries.
        if !marker.cache_retention_applied && !catch_up_tried.swap(true, Ordering::SeqCst) {
            catch_up_cache_retention(executor, dir, config, marker).await;
        }
        return true;
    }
    // A retry in flight reads as `pending`, not as the previous attempt's failure.
    *LAST_ERROR.lock().expect("poisoned") = None;
    // A failed read only costs the skipped-write saving: the writes then report omp's own error.
    let current = list_config_with(executor, &[]).await.ok();
    let write = |key, value| write_to_omp(executor, config, key, value);
    match attempt(dir, current.as_ref(), config, &today(), write).await {
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

/// A failed catch-up only warns: the launch goes on and the next one retries.
async fn catch_up_cache_retention(
    executor: &dyn OmpExecutor,
    dir: &Path,
    config: Option<&Path>,
    marker: Marker,
) {
    // Without a successful read the user's own value is unknown, so nothing is written.
    let current = match list_config_with(executor, &[]).await {
        Ok(current) => current,
        Err(err) => {
            log::warn!(
                "token guard: could not read the omp config for cache retention: {}",
                err.message
            );
            return;
        }
    };
    let write = |key, value| write_to_omp(executor, config, key, value);
    if let Err(err) = apply_cache_retention(dir, marker, &current, write).await {
        log::warn!("token guard: cache retention catch-up failed: {err}");
    }
}

/// omp's unset retention is `auto`; a missing or non-string value counts as unset. Anything else is the user's choice.
fn retention_is_unset(current: &Value) -> bool {
    values::raw_value(current, CACHE_RETENTION_KEY)
        .and_then(Value::as_str)
        .is_none_or(|v| v == "auto")
}

/// Moves omp's unset retention (`auto`) to `long` once for an install migrated earlier; a value the user chose stays.
async fn apply_cache_retention<W, F>(
    dir: &Path,
    marker: Marker,
    current: &Value,
    write: W,
) -> Result<(), String>
where
    W: Fn(String, Value) -> F,
    F: Future<Output = Result<(), String>>,
{
    if retention_is_unset(current) {
        write(CACHE_RETENTION_KEY.to_string(), json!("long"))
            .await
            .map_err(|err| format!("Could not write {CACHE_RETENTION_KEY}: {err}"))?;
    }
    let marker = Marker {
        cache_retention_applied: true,
        ..marker
    };
    write_json_file(&marker_path(dir), &marker)
        .await
        .map_err(|err| format!("Could not record the cache retention: {err}"))
}

pub async fn status(dir: &Path) -> Status {
    if skipped() {
        return Status {
            status: "skipped",
            error: Some(SKIPPED_REASON.to_string()),
            backup_path: None,
        };
    }
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
    use crate::omp::config::{OmpConfigError, OmpConfigErrorCode};
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn date_is_utc_calendar_day() {
        assert_eq!(date_string(0), "1970-01-01");
        assert_eq!(date_string(1_794_000_000), "2026-11-06");
    }

    #[test]
    fn scratch_data_dir_without_agent_dir_skips_the_migration() {
        let scratch = std::env::temp_dir().to_string_lossy().into_owned();
        assert!(shares_real_agent_dir(true, Some(scratch.clone()), None));
        assert!(shares_real_agent_dir(
            true,
            Some(scratch.clone()),
            Some(OsString::new())
        ));
    }

    #[test]
    fn a_scratch_agent_dir_a_real_data_dir_or_a_release_build_runs_it() {
        let scratch = std::env::temp_dir().to_string_lossy().into_owned();
        assert!(!shares_real_agent_dir(
            true,
            Some(scratch.clone()),
            Some(OsString::from(&scratch))
        ));
        assert!(!shares_real_agent_dir(true, None, None));
        assert!(!shares_real_agent_dir(
            true,
            Some("relative/dir".to_string()),
            None
        ));
        assert!(!shares_real_agent_dir(false, Some(scratch), None));
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
        let err = attempt(&dir, None, Some(&config), "2026-11-06", failing)
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
        attempt(&dir, None, Some(&config), "2026-11-06", ok)
            .await
            .unwrap();
        let marker = read_marker(&dir).await.expect("marker");
        let backup = marker.backup_path.unwrap();
        assert!(backup.ends_with("refract-backup-2026-11-06"));
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "a: 1\n");
        let backups = std::fs::read_dir(&dir)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains("refract-backup")
            })
            .count();
        assert_eq!(backups, 1);
        assert!(!legacy::path(&dir).exists());
        let written = written.lock().unwrap();
        assert!(written.contains(&("task.maxConcurrency".to_string(), json!(3))));
        assert!(written.contains(&("compaction.thresholdTokens".to_string(), json!(-1))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn success_marks_done_and_retires_the_file() {
        let dir = scratch("done");
        std::fs::write(legacy::path(&dir), r#"{"version":2,"overrides":{}}"#).unwrap();
        attempt(&dir, None, None, "2026-11-06", |_, _| async { Ok(()) })
            .await
            .unwrap();
        assert!(is_done(&dir).await);
        assert_eq!(status(&dir).await.status, "done");
        assert!(!legacy::path(&dir).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn keys_already_at_the_target_are_not_written_again() {
        let dir = scratch("skip");
        std::fs::write(
            legacy::path(&dir),
            r#"{"version":2,"overrides":{"task.maxConcurrency":3,"task.softRequestBudget":7}}"#,
        )
        .unwrap();
        let current = json!({ "task.maxConcurrency": { "value": 3 } });
        let written = std::sync::Mutex::new(Vec::new());
        let ok = |k: String, _: Value| {
            written.lock().unwrap().push(k);
            async { Ok(()) }
        };
        attempt(&dir, Some(&current), None, "2026-11-06", ok)
            .await
            .unwrap();
        let written = written.lock().unwrap();
        assert!(!written.contains(&"task.maxConcurrency".to_string()));
        assert!(written.contains(&"task.softRequestBudget".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn aged_marker(dir: &Path) {
        std::fs::write(
            marker_path(dir),
            r#"{"backupPath":"b","noticeDismissed":true}"#,
        )
        .unwrap();
    }

    async fn catch_up(
        dir: &Path,
        current: &Value,
        fail: bool,
    ) -> (Vec<(String, Value)>, Result<(), String>) {
        let written = std::sync::Mutex::new(Vec::new());
        let write = |k: String, v: Value| {
            written.lock().unwrap().push((k, v));
            async move {
                if fail {
                    Err("boom".to_string())
                } else {
                    Ok(())
                }
            }
        };
        let marker = read_marker(dir).await.expect("marker");
        let result = apply_cache_retention(dir, marker, current, write).await;
        let written = written.into_inner().unwrap();
        (written, result)
    }

    #[tokio::test]
    async fn an_existing_install_gets_long_once() {
        let dir = scratch("retention-once");
        aged_marker(&dir);
        let auto = json!({ "providers.cacheRetention": { "value": "auto" } });
        let (written, result) = catch_up(&dir, &auto, false).await;
        assert!(result.is_ok());
        assert_eq!(
            written,
            vec![(CACHE_RETENTION_KEY.to_string(), json!("long"))]
        );
        let marker = read_marker(&dir).await.expect("marker");
        assert!(marker.cache_retention_applied);
        assert_eq!(marker.backup_path.as_deref(), Some("b"));
        assert!(marker.notice_dismissed);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_unlisted_retention_is_set_too() {
        let dir = scratch("retention-unlisted");
        aged_marker(&dir);
        let (written, result) = catch_up(&dir, &Value::Null, false).await;
        assert!(result.is_ok());
        assert_eq!(written.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_deliberate_cache_retention_is_kept() {
        for chosen in ["short", "none", "long"] {
            let dir = scratch(&format!("retention-kept-{chosen}"));
            aged_marker(&dir);
            let current = json!({ "providers.cacheRetention": { "value": chosen } });
            let (written, result) = catch_up(&dir, &current, false).await;
            assert!(result.is_ok());
            assert!(written.is_empty(), "{chosen}");
            assert!(
                read_marker(&dir)
                    .await
                    .expect("marker")
                    .cache_retention_applied
            );
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[tokio::test]
    async fn a_failed_cache_retention_write_leaves_the_flag_unset_for_a_retry() {
        let dir = scratch("retention-retry");
        aged_marker(&dir);
        let (_, result) = catch_up(&dir, &Value::Null, true).await;
        assert!(result.unwrap_err().contains("boom"));
        assert!(
            !read_marker(&dir)
                .await
                .expect("marker")
                .cache_retention_applied
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_fresh_migration_records_cache_retention_applied() {
        let dir = scratch("retention-fresh");
        let written = std::sync::Mutex::new(Vec::new());
        let ok = |k: String, v: Value| {
            written.lock().unwrap().push((k, v));
            async { Ok(()) }
        };
        attempt(&dir, Some(&Value::Null), None, "2026-11-26", ok)
            .await
            .unwrap();
        assert!(
            read_marker(&dir)
                .await
                .expect("marker")
                .cache_retention_applied
        );
        assert!(written
            .lock()
            .unwrap()
            .contains(&(CACHE_RETENTION_KEY.to_string(), json!("long"))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// What `attempt` wrote for one fresh migration against `current`, and the marker it left.
    async fn fresh_migration(
        name: &str,
        current: Option<&Value>,
    ) -> (Vec<(String, Value)>, Marker) {
        let dir = scratch(name);
        let written = std::sync::Mutex::new(Vec::new());
        let ok = |k: String, v: Value| {
            written.lock().unwrap().push((k, v));
            async { Ok(()) }
        };
        attempt(&dir, current, None, "2026-11-26", ok)
            .await
            .unwrap();
        let marker = read_marker(&dir).await.expect("marker");
        let _ = std::fs::remove_dir_all(&dir);
        (written.into_inner().unwrap(), marker)
    }

    fn writes_retention(written: &[(String, Value)]) -> bool {
        written.iter().any(|(k, _)| k == CACHE_RETENTION_KEY)
    }

    #[tokio::test]
    async fn a_fresh_migration_keeps_a_deliberate_cache_retention() {
        for chosen in ["short", "none", "long"] {
            let current = json!({ "providers.cacheRetention": { "value": chosen } });
            let (written, marker) =
                fresh_migration(&format!("fresh-kept-{chosen}"), Some(&current)).await;
            assert!(!writes_retention(&written), "{chosen}");
            assert!(marker.cache_retention_applied, "{chosen}");
        }
    }

    #[tokio::test]
    async fn a_fresh_migration_sets_long_over_auto_or_a_non_string() {
        for stored in [json!("auto"), json!(7)] {
            let current = json!({ "providers.cacheRetention": { "value": stored } });
            let (written, _) = fresh_migration("fresh-unset", Some(&current)).await;
            assert!(written.contains(&(CACHE_RETENTION_KEY.to_string(), json!("long"))));
        }
    }

    #[tokio::test]
    async fn a_fresh_migration_skips_cache_retention_when_the_config_read_failed() {
        let (written, marker) = fresh_migration("fresh-unread", None).await;
        assert!(!writes_retention(&written));
        assert!(!marker.cache_retention_applied);
    }

    /// Answers `omp config list` with `list` (an error when `None`) and every other call with `{}`; records each call's subcommand.
    struct ScriptedOmp {
        list: Option<String>,
        calls: std::sync::Mutex<Vec<String>>,
    }

    impl ScriptedOmp {
        fn new(list: Option<&str>) -> Self {
            Self {
                list: list.map(str::to_string),
                calls: std::sync::Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl OmpExecutor for ScriptedOmp {
        fn call<'a>(
            &'a self,
            args: &'a [String],
            _failure_message: &'a str,
            _strip_env_vars: &'a [&'a str],
        ) -> Pin<Box<dyn Future<Output = Result<String, OmpConfigError>> + Send + 'a>> {
            let subcommand = args.get(1).cloned().unwrap_or_default();
            self.calls.lock().unwrap().push(subcommand.clone());
            let result = match (subcommand.as_str(), &self.list) {
                ("list", Some(list)) => Ok(list.clone()),
                ("list", None) => Err(OmpConfigError::new(
                    OmpConfigErrorCode::OmpFailed,
                    "omp is not answering",
                )),
                _ => Ok("{}".to_string()),
            };
            Box::pin(async move { result })
        }
    }

    #[tokio::test]
    async fn a_failing_config_read_writes_nothing_and_is_not_retried_this_launch() {
        if skipped() {
            return;
        }
        let dir = scratch("catch-up-unreadable");
        aged_marker(&dir);
        let omp = ScriptedOmp::new(None);
        let tried = AtomicBool::new(false);
        assert!(ensure_once_per_launch(&omp, &dir, None, &tried).await);
        assert_eq!(omp.calls(), vec!["list"]);
        assert!(
            !read_marker(&dir)
                .await
                .expect("marker")
                .cache_retention_applied
        );
        assert!(ensure_once_per_launch(&omp, &dir, None, &tried).await);
        assert_eq!(omp.calls(), vec!["list"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn after_a_successful_catch_up_a_second_run_makes_no_further_calls() {
        if skipped() {
            return;
        }
        let dir = scratch("catch-up-done");
        aged_marker(&dir);
        let omp = ScriptedOmp::new(Some(r#"{"providers.cacheRetention":{"value":"auto"}}"#));
        let tried = AtomicBool::new(false);
        assert!(ensure_once_per_launch(&omp, &dir, None, &tried).await);
        assert_eq!(omp.calls(), vec!["list", "set"]);
        assert!(
            read_marker(&dir)
                .await
                .expect("marker")
                .cache_retention_applied
        );
        assert!(ensure_once_per_launch(&omp, &dir, None, &tried).await);
        assert_eq!(omp.calls(), vec!["list", "set"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An `omp` that must never be called: a run that finds the marker writes and reads nothing.
    struct NeverCalled(AtomicUsize);

    impl OmpExecutor for NeverCalled {
        fn call<'a>(
            &'a self,
            _args: &'a [String],
            _failure_message: &'a str,
            _strip_env_vars: &'a [&'a str],
        ) -> Pin<Box<dyn Future<Output = Result<String, OmpConfigError>> + Send + 'a>> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok("{}".to_string()) })
        }
    }

    #[tokio::test]
    async fn a_second_run_waits_on_the_lock_then_finds_the_marker_and_writes_nothing() {
        if skipped() {
            return;
        }
        let dir = scratch("lock");
        let held = RUN_LOCK.lock().await;
        let omp = std::sync::Arc::new(NeverCalled(AtomicUsize::new(0)));
        let waiting = {
            let (omp, dir) = (std::sync::Arc::clone(&omp), dir.clone());
            tokio::spawn(async move { ensure_with(&*omp, &dir, None).await })
        };
        // Yielding lets the spawned run execute as far as it can on this single-threaded runtime: a run that
        // ignored the lock would finish (and call omp) long before the marker below exists.
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        assert!(!waiting.is_finished(), "the run must wait on the lock");
        assert_eq!(omp.0.load(Ordering::SeqCst), 0);
        std::fs::write(marker_path(&dir), r#"{"cacheRetentionApplied":true}"#).unwrap();
        drop(held);
        assert!(waiting.await.unwrap());
        assert_eq!(omp.0.load(Ordering::SeqCst), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
