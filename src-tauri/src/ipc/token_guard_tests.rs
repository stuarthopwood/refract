use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex as StdMutex;

use tokio::sync::Mutex as AsyncMutex;

use super::*;
use crate::events::EventSink;
use crate::omp::config::refuse_real_omp::Forbid;
use crate::omp::config::{OmpConfigError, OmpConfigErrorCode};
use crate::omp::token_guard::overlay::{path as overlay_path, write_legacy};
use crate::session::SessionManager;
use crate::store::registry::RegistryStore;
use crate::store::settings::SettingsStore;

/// The migration marker, the omp invocation lock and the remembered snapshot are process-wide.
static SERIAL: AsyncMutex<()> = AsyncMutex::const_new(());

/// Fake `omp`: records argv, can fail every `config set`, and snapshots a watched file at each set.
struct FakeOmp {
    calls: StdMutex<Vec<Vec<String>>>,
    fail_sets: AtomicBool,
    watched: Option<PathBuf>,
    seen_at_set: StdMutex<Vec<Option<String>>>,
    /// What `omp --version` prints.
    version: &'static str,
}

impl FakeOmp {
    fn new(watched: Option<PathBuf>) -> Self {
        Self {
            calls: StdMutex::new(Vec::new()),
            fail_sets: AtomicBool::new(false),
            watched,
            seen_at_set: StdMutex::new(Vec::new()),
            version: "19.1.1\n",
        }
    }

    fn with_version(version: &'static str) -> Self {
        Self {
            version,
            ..Self::new(None)
        }
    }

    fn sets(&self) -> Vec<Vec<String>> {
        let calls = self.calls.lock().unwrap();
        calls
            .iter()
            .filter(|c| c.get(1).is_some_and(|a| a == "set"))
            .cloned()
            .collect()
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
            if args[0] == "--version" {
                return Ok(self.version.to_string());
            }
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
    std::fs::write(
        dir.join("token-guard-migration.json"),
        r#"{"cacheRetentionApplied":true}"#,
    )
    .unwrap();
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

/// Runs `Change::Set` of the rare-tools key against a fake omp of `version` and a global config holding `yaml`.
async fn set_rare_tools(
    version: &'static str,
    yaml: &str,
    name: &str,
) -> (Vec<Vec<String>>, String) {
    let dir = scratch(name);
    migrated(&dir);
    let config = dir.join("config.yml");
    std::fs::write(&config, yaml).unwrap();
    let omp = FakeOmp::with_version(version);
    let change = Change::Set("tools.commands".to_string(), json!(false));
    apply_change(&omp, &dir, Some(&config), false, change)
        .await
        .unwrap();
    let text = std::fs::read_to_string(&config).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    (omp.sets(), text)
}

#[tokio::test]
async fn the_rare_tools_toggle_is_written_as_tools_commands_on_omp_19_and_drops_xdev() {
    let _serial = SERIAL.lock().await;
    values::forget();
    let yaml = "tools:\n  xdev: true\n  artifactSpillThreshold: 30\n";
    let (sets, text) = set_rare_tools("19.1.1\n", yaml, "commands").await;
    assert_eq!(sets, vec![set_call("tools.commands", "false")]);
    assert_eq!(text, "tools:\n  artifactSpillThreshold: 30\n");
}

#[tokio::test]
async fn the_rare_tools_toggle_is_written_as_tools_xdev_on_omp_18_and_drops_commands() {
    let _serial = SERIAL.lock().await;
    values::forget();
    let yaml = "tools:\n  commands: true\n  artifactSpillThreshold: 30\n";
    let (sets, text) = set_rare_tools("18.22.2\n", yaml, "xdev").await;
    assert_eq!(sets, vec![set_call("tools.xdev", "false")]);
    assert_eq!(text, "tools:\n  artifactSpillThreshold: 30\n");
}

#[tokio::test]
async fn an_unreadable_omp_version_writes_tools_commands() {
    let _serial = SERIAL.lock().await;
    values::forget();
    let (sets, _) = set_rare_tools("no version here\n", "tools:\n  xdev: true\n", "unparsed").await;
    assert_eq!(sets, vec![set_call("tools.commands", "false")]);
}

#[tokio::test]
async fn reset_all_on_omp_19_writes_tools_commands_and_drops_a_stale_xdev() {
    let _serial = SERIAL.lock().await;
    values::forget();
    let dir = scratch("reset-all-xdev");
    migrated(&dir);
    let config = dir.join("config.yml");
    std::fs::write(
        &config,
        "tools:\n  xdev: true\n  artifactSpillThreshold: 30\n",
    )
    .unwrap();
    let omp = FakeOmp::new(None);
    apply_change(&omp, &dir, Some(&config), false, Change::ResetAll)
        .await
        .unwrap();
    let sets = omp.sets();
    assert!(sets.contains(&set_call("tools.commands", "true")));
    assert!(!sets.iter().any(|call| call[2] == "tools.xdev"));
    assert_eq!(
        std::fs::read_to_string(&config).unwrap(),
        "tools:\n  artifactSpillThreshold: 30\n"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn without_a_config_path_the_rare_tools_write_touches_no_file() {
    let _serial = SERIAL.lock().await;
    values::forget();
    let dir = scratch("no-config");
    migrated(&dir);
    let config = dir.join("config.yml");
    let yaml = "tools:\n  xdev: true\n";
    std::fs::write(&config, yaml).unwrap();
    let files = || std::fs::read_dir(&dir).unwrap().count();
    let count = files();
    let omp = FakeOmp::new(None);
    let change = Change::Set("tools.commands".to_string(), json!(false));
    apply_change(&omp, &dir, None, false, change).await.unwrap();
    assert_eq!(omp.sets(), vec![set_call("tools.commands", "false")]);
    assert_eq!(std::fs::read_to_string(&config).unwrap(), yaml);
    assert_eq!(files(), count);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_failed_stale_key_removal_does_not_fail_the_saved_toggle() {
    let _serial = SERIAL.lock().await;
    values::forget();
    let dir = scratch("removal-fails");
    migrated(&dir);
    // A directory where the config file should be cannot be read as text, so the removal errors.
    let config = dir.join("config.yml");
    std::fs::create_dir(&config).unwrap();
    let omp = FakeOmp::new(None);
    let change = Change::Set("tools.commands".to_string(), json!(false));
    let applied = apply_change(&omp, &dir, Some(&config), false, change)
        .await
        .unwrap();
    assert_eq!(omp.sets(), vec![set_call("tools.commands", "false")]);
    assert_eq!(applied.updated.values["tools.commands"], json!(false));
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

/// An `AppState` whose data dir is the migration dir under test; its stores live apart so they add no files there.
async fn state_for(data_dir: &Path, stores_dir: &Path) -> AppState {
    let registry = RegistryStore::open(stores_dir)
        .await
        .expect("open registry");
    let settings = SettingsStore::open(stores_dir)
        .await
        .expect("open settings");
    let registry = Arc::new(AsyncMutex::new(registry));
    let settings = Arc::new(AsyncMutex::new(settings));
    let app_handle: Arc<StdMutex<Option<tauri::AppHandle>>> = Arc::new(StdMutex::new(None));
    let events = EventSink::new(app_handle.clone(), registry.clone());
    let session_manager = SessionManager::new(registry.clone(), settings.clone(), events);
    AppState {
        data_dir: data_dir.to_path_buf(),
        registry,
        settings,
        app_handle,
        session_manager,
    }
}

/// The offline state the pending-read test needs, undone when it drops so a failed assert still resets the cache and removes the dirs.
struct OfflineRead {
    dir: PathBuf,
    stores: PathBuf,
}

impl OfflineRead {
    fn new() -> Self {
        // A cold cache would make the handler run `omp models`; an empty one keeps the read offline.
        *CONTEXT_WINDOWS.lock().unwrap() = Some(Arc::new(HashMap::new()));
        Self {
            dir: scratch("read-pending"),
            stores: scratch("read-pending-stores"),
        }
    }
}

impl Drop for OfflineRead {
    fn drop(&mut self) {
        *CONTEXT_WINDOWS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        let _ = std::fs::remove_dir_all(&self.dir);
        let _ = std::fs::remove_dir_all(&self.stores);
    }
}

/// Goes through the real `tokenGuard.get` handler. The real `omp` is forbidden, so a migration start re-added to it
/// fails here at once (the call is refused and counted) instead of rewriting the developer's global config.
#[tokio::test]
async fn a_read_while_the_migration_is_pending_writes_nothing() {
    let _serial = SERIAL.lock().await;
    if migrate::skipped() {
        return;
    }
    let no_omp = Forbid::new();
    values::forget();
    let offline = OfflineRead::new();
    let dir = offline.dir.as_path();
    write_legacy(dir, &values::defaults()).await.unwrap();
    let before = std::fs::read_to_string(overlay_path(dir)).unwrap();
    let files = || std::fs::read_dir(dir).unwrap().count();
    let count = files();
    let state = state_for(dir, &offline.stores).await;

    let snapshot = token_guard_get(state, Vec::new()).await.unwrap();

    assert_eq!(no_omp.refused(), 0, "a read must not start omp");
    assert_eq!(snapshot["migration"]["status"], json!("pending"));
    assert_eq!(
        snapshot["values"],
        json!(values::to_object(&legacy::effective(dir).await))
    );
    assert_eq!(files(), count, "a read must not create or retire any file");
    assert!(!dir.join("token-guard-migration.json").exists());
    assert_eq!(std::fs::read_to_string(overlay_path(dir)).unwrap(), before);
}

#[test]
fn a_failed_legacy_refresh_becomes_a_warning_and_a_good_one_does_not() {
    assert_eq!(refresh_warning(Ok(())), None);
    let err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "read-only");
    let warning = refresh_warning(Err(err)).unwrap();
    assert!(warning.starts_with("Saved, but"));
    assert!(warning.contains("read-only"));
}
