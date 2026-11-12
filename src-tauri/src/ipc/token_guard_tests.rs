use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex as StdMutex;

use tokio::sync::Mutex as AsyncMutex;

use super::*;
use crate::omp::config::{OmpConfigError, OmpConfigErrorCode};
use crate::omp::token_guard::overlay::{path as overlay_path, write_legacy};

/// The migration marker, the omp invocation lock and the remembered snapshot are process-wide.
static SERIAL: AsyncMutex<()> = AsyncMutex::const_new(());

/// Fake `omp`: records argv, can fail every `config set`, and snapshots a watched file at each set.
struct FakeOmp {
    calls: StdMutex<Vec<Vec<String>>>,
    fail_sets: AtomicBool,
    watched: Option<PathBuf>,
    seen_at_set: StdMutex<Vec<Option<String>>>,
}

impl FakeOmp {
    fn new(watched: Option<PathBuf>) -> Self {
        Self {
            calls: StdMutex::new(Vec::new()),
            fail_sets: AtomicBool::new(false),
            watched,
            seen_at_set: StdMutex::new(Vec::new()),
        }
    }

    fn sets(&self) -> Vec<Vec<String>> {
        let calls = self.calls.lock().unwrap();
        calls.iter().filter(|c| c[1] == "set").cloned().collect()
    }
}

impl OmpExecutor for FakeOmp {
    fn call<'a>(
        &'a self,
        args: &'a [String],
        _failure_message: &'a str,
        _strip_env_vars: &'a [&'a str],
    ) -> Pin<Box<dyn Future<Output = Result<String, OmpConfigError>> + Send + 'a>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(args.to_vec());
            match args[1].as_str() {
                // The advisor already holds its default, so the migration does not go through the role merge.
                "list" => Ok(
                    r#"{"modelRoles":{"value":{"advisor":"github-copilot/gemini-4-argon:auto"}}}"#
                        .to_string(),
                ),
                "get" => Ok(r#"{"value":{}}"#.to_string()),
                "set" => {
                    let seen = self
                        .watched
                        .as_ref()
                        .and_then(|p| std::fs::read_to_string(p).ok());
                    self.seen_at_set.lock().unwrap().push(seen);
                    if self.fail_sets.load(Ordering::SeqCst) {
                        return Err(OmpConfigError::new(
                            OmpConfigErrorCode::OmpFailed,
                            "omp is unavailable",
                        ));
                    }
                    Ok("{}".to_string())
                }
                other => panic!("unexpected omp call: {other}"),
            }
        })
    }
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("refract-ipc-tg-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn migrated(dir: &Path) {
    std::fs::write(dir.join("token-guard-migration.json"), "{}").unwrap();
}

fn set_call(key: &str, json: &str) -> Vec<String> {
    ["config", "set", key, "--json", "--", json]
        .map(String::from)
        .to_vec()
}

#[tokio::test]
async fn a_live_key_is_written_to_the_global_config() {
    let _serial = SERIAL.lock().await;
    values::forget();
    let dir = scratch("live");
    migrated(&dir);
    let omp = FakeOmp::new(None);
    let change = Change::Set("compaction.thresholdPercent".to_string(), json!(55));
    let applied = apply_change(&omp, &dir, None, false, change).await.unwrap();
    assert_eq!(
        omp.sets(),
        vec![set_call("compaction.thresholdPercent", "55")]
    );
    assert_eq!(
        applied.updated.values["compaction.thresholdPercent"],
        json!(55)
    );
    assert!(applied.warnings.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn reset_and_reset_all_write_the_defaults() {
    let _serial = SERIAL.lock().await;
    values::forget();
    let dir = scratch("reset");
    migrated(&dir);
    let omp = FakeOmp::new(None);
    let reset = Change::Reset("task.softRequestBudget".to_string());
    apply_change(&omp, &dir, None, false, reset).await.unwrap();
    assert_eq!(omp.sets(), vec![set_call("task.softRequestBudget", "60")]);

    let all = FakeOmp::new(None);
    apply_change(&all, &dir, None, false, Change::ResetAll)
        .await
        .unwrap();
    assert!(all.sets().len() > 10);
    assert!(all
        .sets()
        .contains(&set_call("compaction.thresholdPercent", "70")));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn the_write_runs_after_the_migrate_check_and_before_the_overlay_refresh() {
    let _serial = SERIAL.lock().await;
    values::forget();
    let dir = scratch("order");
    write_legacy(&dir, &values::defaults()).await.unwrap();
    let omp = FakeOmp::new(Some(overlay_path(&dir)));
    let change = Change::Set("task.softRequestBudget".to_string(), json!(30));
    let applied = apply_change(&omp, &dir, None, true, change).await.unwrap();

    let sets = omp.sets();
    let last = sets.len() - 1;
    // The pending migration wrote first (it pins `thresholdTokens` off), the user's key last.
    assert!(sets[..last].contains(&set_call("compaction.thresholdTokens", "-1")));
    assert_eq!(sets[last], set_call("task.softRequestBudget", "30"));
    assert_eq!(omp.calls.lock().unwrap()[0][1], "list");
    // When the user's key was written the legacy overlay was still the old one; the refresh came after.
    let seen = omp.seen_at_set.lock().unwrap();
    assert!(seen[last]
        .as_ref()
        .unwrap()
        .contains("softRequestBudget: 60\n"));
    let refreshed = std::fs::read_to_string(overlay_path(&dir)).unwrap();
    assert!(refreshed.contains("softRequestBudget: 30\n"));
    assert!(applied.warnings.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_pending_migration_is_retried_inside_the_write_and_then_succeeds() {
    let _serial = SERIAL.lock().await;
    values::forget();
    let dir = scratch("retry");
    let omp = FakeOmp::new(None);
    omp.fail_sets.store(true, Ordering::SeqCst);
    let change = || Change::Set("compaction.thresholdPercent".to_string(), json!(55));

    let refused = apply_change(&omp, &dir, None, false, change()).await;
    assert!(refused.err().unwrap().contains("omp is unavailable"));
    assert!(!dir.join("token-guard-migration.json").exists());
    assert!(
        !omp.sets()
            .contains(&set_call("compaction.thresholdPercent", "55")),
        "the user's key is not written while the migration is pending"
    );

    omp.fail_sets.store(false, Ordering::SeqCst);
    let applied = apply_change(&omp, &dir, None, false, change())
        .await
        .unwrap();
    assert!(dir.join("token-guard-migration.json").exists());
    assert_eq!(
        applied.updated.values["compaction.thresholdPercent"],
        json!(55)
    );
    assert_eq!(
        omp.sets().last(),
        Some(&set_call("compaction.thresholdPercent", "55"))
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn the_legacy_overlay_is_left_alone_when_no_pre_migration_session_launched() {
    let _serial = SERIAL.lock().await;
    values::forget();
    let dir = scratch("skip-refresh");
    migrated(&dir);
    write_legacy(&dir, &values::defaults()).await.unwrap();
    let before = std::fs::read_to_string(overlay_path(&dir)).unwrap();
    let omp = FakeOmp::new(None);
    let change = Change::Set("task.softRequestBudget".to_string(), json!(30));
    apply_change(&omp, &dir, None, false, change).await.unwrap();
    assert_eq!(std::fs::read_to_string(overlay_path(&dir)).unwrap(), before);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_failed_legacy_refresh_becomes_a_warning_and_a_good_one_does_not() {
    assert_eq!(refresh_warning(Ok(())), None);
    let err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "read-only");
    let warning = refresh_warning(Err(err)).unwrap();
    assert!(warning.starts_with("Saved, but"));
    assert!(warning.contains("read-only"));
}
