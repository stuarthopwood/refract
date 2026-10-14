// Test module for `repositories.rs`, split into its own file via `#[path = ...]` (same pattern
// `git/worktree_delete.rs` uses for `worktree_delete_tests.rs`) to keep `repositories.rs` itself
// under the 600-line soft cap.

use super::*;
use crate::events::EventSink;
use crate::session::SessionManager;
use crate::store::registry::RegistryStore;
use crate::store::settings::SettingsStore;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex as AsyncMutex;

fn temp_dir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "refract-repositories-rename-test-{label}-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn run_git(dir: &std::path::Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .status()
        .expect("git must be on PATH for this test");
    assert!(status.success(), "git {args:?} failed in {dir:?}");
}

async fn make_state(dir: &std::path::Path) -> AppState {
    let registry = RegistryStore::open(dir).await.expect("open registry");
    let settings = SettingsStore::open(dir).await.expect("open settings");
    let registry = Arc::new(AsyncMutex::new(registry));
    let settings = Arc::new(AsyncMutex::new(settings));
    let app_handle_slot: Arc<StdMutex<Option<tauri::AppHandle>>> = Arc::new(StdMutex::new(None));
    let events = EventSink::new(app_handle_slot.clone(), registry.clone());
    let session_manager = SessionManager::new(registry.clone(), settings.clone(), events);
    AppState {
        data_dir: dir.to_path_buf(),
        registry,
        settings,
        app_handle: app_handle_slot,
        session_manager,
    }
}

// Port of `renameRepository.test.ts`'s own pure-function coverage, against this crate's
// `validate_repository_name`/`resolve_repository_name` (the `repositoryName.ts` port).

#[test]
fn trims_surrounding_whitespace_before_validating() {
    let trimmed = "  My Repo  ".trim();
    assert_eq!(trimmed, "My Repo");
    assert!(validate_repository_name(trimmed).is_none());
    assert_eq!(resolve_repository_name(trimmed, "basename"), "My Repo");
}

#[test]
fn resolves_an_empty_post_trim_name_to_the_folder_basename_not_an_error() {
    assert!(validate_repository_name("").is_none());
    assert_eq!(resolve_repository_name("", "my-repo"), "my-repo");
}

#[test]
fn resolves_a_zero_width_joiner_only_name_to_the_folder_basename_not_an_error() {
    let name = "\u{200D}\u{200C}";
    assert!(validate_repository_name(name).is_none());
    assert_eq!(resolve_repository_name(name, "my-repo"), "my-repo");
}

#[test]
fn rejects_an_over_length_name_with_an_unprefixed_inline_safe_message() {
    let name = "x".repeat(61);
    let error = validate_repository_name(&name).expect("over-length name must be rejected");
    assert!(error.contains("too long"));
    assert!(!error.contains("repositories.rename"));
}

#[test]
fn rejects_control_characters() {
    let name = "bad\u{0007}name";
    let error = validate_repository_name(name).expect("control character must be rejected");
    assert_eq!(error, "name must not contain control characters");
}

// Port of `renameRepository.test.ts`'s own handler-level coverage, against this crate's
// `repositories_rename` (the `renameRepositoryCore` port) and a real temp-dir `RegistryStore`
// (same pattern the TS tests themselves use: never cleaned up).

#[tokio::test]
async fn repositories_rename_returns_not_found_for_an_unknown_repository_id() {
    let dir = temp_dir("not-found");
    let state = make_state(&dir).await;
    let args = vec![
        Value::String("missing-id".to_string()),
        Value::String("New name".to_string()),
    ];
    let err = repositories_rename(state, args)
        .await
        .expect_err("unknown repository id must error");
    assert_eq!(err.code, "not-found");
}

/// Ported from `repositories.ts`'s own handler (not `repositoryName.ts`'s pure functions): a
/// defence-in-depth rejection of a RAW (untrimmed) name over 4x the real 60-character limit,
/// checked before the repository lookup even runs -- any id works, since this never reaches
/// `validate_repository_name` at all.
#[tokio::test]
async fn repositories_rename_rejects_a_raw_name_over_4x_the_limit_before_any_lookup() {
    let dir = temp_dir("pre-trim-too-long");
    let state = make_state(&dir).await;
    let args = vec![
        Value::String("any-id-at-all".to_string()),
        Value::String("x".repeat(241)),
    ];
    let err = repositories_rename(state, args)
        .await
        .expect_err("a raw name over 4x the limit must be rejected");
    assert_eq!(err.code, "invalid-argument");
    assert!(err.message.contains("too long"));
}

#[tokio::test]
async fn repositories_rename_notifies_the_list_and_returns_the_updated_repository() {
    let dir = temp_dir("success");
    let state = make_state(&dir).await;
    let repository = Repository {
        id: "repo-1".to_string(),
        path: dir.to_string_lossy().into_owned(),
        name: "old-name".to_string(),
        default_branch: "main".to_string(),
        added_at: "2026-01-01T00:00:00.000Z".to_string(),
    };
    state
        .registry
        .lock()
        .await
        .add_repository(repository.clone())
        .await
        .expect("add_repository");
    let args = vec![
        Value::String("repo-1".to_string()),
        Value::String("  Renamed  ".to_string()),
    ];
    let result = repositories_rename(state.clone(), args)
        .await
        .expect("rename must succeed");
    assert_eq!(result.get("name").and_then(Value::as_str), Some("Renamed"));
    let persisted_name = state
        .registry
        .lock()
        .await
        .get_repository("repo-1")
        .expect("repository must still exist")
        .name
        .clone();
    assert_eq!(persisted_name, "Renamed");
}

// Issue #528 parity (gate round 1 remediation): `.rename` recomputes the real remote inline,
// same as `.add`, rather than returning the `unknown` placeholder `.list` uses.
#[tokio::test]
async fn repositories_rename_recomputes_the_real_remote_for_a_configured_origin() {
    let dir = temp_dir("rename-real-remote");
    run_git(&dir, &["init", "-q"]);
    run_git(
        &dir,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/owner/repo.git",
        ],
    );
    let state = make_state(&dir).await;
    let repository = Repository {
        id: "repo-1".to_string(),
        path: dir.to_string_lossy().into_owned(),
        name: "old-name".to_string(),
        default_branch: "main".to_string(),
        added_at: "2026-01-01T00:00:00.000Z".to_string(),
    };
    state
        .registry
        .lock()
        .await
        .add_repository(repository.clone())
        .await
        .expect("add_repository");
    let args = vec![
        Value::String("repo-1".to_string()),
        Value::String("Renamed".to_string()),
    ];
    let result = repositories_rename(state, args)
        .await
        .expect("rename must succeed");
    assert_eq!(
        result.get("remote"),
        Some(&serde_json::json!({ "kind": "has", "host": "github.com" }))
    );
}

// Gate round 1 remediation: a second `repositories.remotes` call that arrives while a sweep is
// already running must share that same sweep's result, never start a second full pool of `git`
// spawns concurrently with the first (`repositories.ts`'s own `remotesInFlight`). `tokio::join!`
// polls both calls from the same enclosing future, so the second call's own
// `{ check REMOTES_IN_FLIGHT }` block runs before the first call's `remotes_bounded` has had a
// chance to settle, exercising the actual sharing path, not just two back-to-back sweeps.
#[tokio::test]
async fn repositories_remotes_shares_a_single_in_flight_sweep_across_concurrent_calls() {
    let dir = temp_dir("remotes-in-flight");
    let repo_dir = dir.join("repo");
    std::fs::create_dir_all(&repo_dir).expect("create repo dir");
    run_git(&repo_dir, &["init", "-q"]);
    run_git(
        &repo_dir,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/owner/repo.git",
        ],
    );
    let state = make_state(&dir).await;
    state
        .registry
        .lock()
        .await
        .add_repository(Repository {
            id: "repo-1".to_string(),
            path: repo_dir.to_string_lossy().into_owned(),
            name: "repo".to_string(),
            default_branch: "main".to_string(),
            added_at: "2026-01-01T00:00:00.000Z".to_string(),
        })
        .await
        .expect("add_repository");

    let (first, second) = tokio::join!(
        repositories_remotes(state.clone(), vec![]),
        repositories_remotes(state.clone(), vec![])
    );
    let first = first.expect("first remotes sweep must succeed");
    let second = second.expect("second remotes sweep must succeed");
    assert_eq!(
        first, second,
        "concurrent sweeps must agree on every result"
    );
    assert_eq!(
        first.get("repo-1"),
        Some(&serde_json::json!({ "kind": "has", "host": "github.com" }))
    );
}
