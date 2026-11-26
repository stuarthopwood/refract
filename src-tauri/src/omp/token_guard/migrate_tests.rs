// Tests for the token guard migration; see migrate.rs.

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
async fn fresh_migration(name: &str, current: Option<&Value>) -> (Vec<(String, Value)>, Marker) {
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
