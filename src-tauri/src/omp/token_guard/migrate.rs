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

// Tests live in a sibling file, as in `ipc/token_guard.rs`.
#[cfg(test)]
#[path = "migrate_tests.rs"]
mod tests;
