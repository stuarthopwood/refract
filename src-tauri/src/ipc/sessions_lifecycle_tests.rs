// Test module for `sessions_lifecycle.rs`, split into this sibling file to stay under the
// 600-line soft cap (`pnpm check:file-size`) -- included via `#[path =
// "sessions_lifecycle_tests.rs"] mod tests;` in `sessions_lifecycle.rs` itself, so this is still
// logically `ipc::sessions_lifecycle::tests` (same convention `store/registry_tests.rs` already
// uses). Scratch dirs are left in the OS temp folder (never removed), the same deliberate choice
// this crate's other test modules already make.

use super::*;
use crate::events::EventSink;
use crate::git::test_support::init_repo;
use crate::session::{SessionManager, SessionStatus};
use crate::store::registry::{RegistryStore, Repository};
use crate::store::settings::SettingsStore;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex as AsyncMutex;

// `is_strict_descendant_of_omp_sessions`: pure string/path function, no git/tokio runtime
// needed. `dirs::home_dir()` is the same mechanism the function itself already uses.

#[test]
fn the_sessions_root_itself_is_not_a_strict_descendant() {
    let home = dirs::home_dir().expect("home dir for test");
    let root = home.join(".omp").join("agent").join("sessions");
    assert!(!is_strict_descendant_of_omp_sessions(
        &root.to_string_lossy()
    ));
}

#[test]
fn a_true_child_of_the_sessions_root_is_a_strict_descendant() {
    let home = dirs::home_dir().expect("home dir for test");
    let child = home
        .join(".omp")
        .join("agent")
        .join("sessions")
        .join("abc123");
    assert!(is_strict_descendant_of_omp_sessions(
        &child.to_string_lossy()
    ));
}

/// A sibling directory sharing a string prefix with the real root (e.g. `sessions-evil` next to
/// `sessions`) must never pass a naive `starts_with` on the unseparated string -- exactly why the
/// function itself appends `MAIN_SEPARATOR` before comparing.
#[test]
fn a_sibling_directory_sharing_a_string_prefix_is_not_a_descendant() {
    let home = dirs::home_dir().expect("home dir for test");
    let root = home.join(".omp").join("agent").join("sessions");
    let lookalike_sibling = root.with_file_name("sessions-evil");
    assert!(!is_strict_descendant_of_omp_sessions(
        &lookalike_sibling.to_string_lossy()
    ));
}

#[test]
fn a_path_that_escapes_the_root_via_dotdot_is_not_a_descendant() {
    let home = dirs::home_dir().expect("home dir for test");
    let root = home.join(".omp").join("agent").join("sessions");
    let escaping = root.join("abc123").join("..").join("..").join("elsewhere");
    assert!(!is_strict_descendant_of_omp_sessions(
        &escaping.to_string_lossy()
    ));
}

// `delete_session_conversations`: real temp dir, same `refract-...-{uuid}` pattern this crate's
// other test modules already use (never cleaned up).

fn temp_session_dir(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "refract-sessions-lifecycle-test-{label}-{}",
        uuid::Uuid::new_v4()
    ))
}

#[tokio::test]
async fn deletes_only_jsonl_files_and_their_same_stem_sibling_directories() {
    let dir = temp_session_dir("jsonl-and-sibling");
    tokio::fs::create_dir_all(&dir).await.unwrap();
    tokio::fs::write(dir.join("conv.jsonl"), b"{}")
        .await
        .unwrap();
    tokio::fs::create_dir_all(dir.join("conv")).await.unwrap();
    tokio::fs::write(dir.join("conv").join("subagent.jsonl"), b"{}")
        .await
        .unwrap();
    tokio::fs::write(dir.join("other.txt"), b"keep")
        .await
        .unwrap();
    tokio::fs::create_dir_all(dir.join("other-dir"))
        .await
        .unwrap();

    delete_session_conversations(&dir.to_string_lossy()).await;

    assert!(tokio::fs::metadata(dir.join("conv.jsonl")).await.is_err());
    assert!(tokio::fs::metadata(dir.join("conv")).await.is_err());
    assert!(tokio::fs::metadata(dir.join("other.txt")).await.is_ok());
    assert!(tokio::fs::metadata(dir.join("other-dir")).await.is_ok());
}

#[tokio::test]
async fn session_dir_survives_when_an_unrelated_file_remains_after_cleanup() {
    let dir = temp_session_dir("retained-file");
    tokio::fs::create_dir_all(&dir).await.unwrap();
    tokio::fs::write(dir.join("conv.jsonl"), b"{}")
        .await
        .unwrap();
    tokio::fs::write(dir.join("other.txt"), b"keep")
        .await
        .unwrap();

    delete_session_conversations(&dir.to_string_lossy()).await;

    assert!(
        tokio::fs::metadata(&dir).await.is_ok(),
        "session_dir must survive while a non-Conversation file remains"
    );
    assert!(tokio::fs::metadata(dir.join("other.txt")).await.is_ok());
}

#[tokio::test]
async fn session_dir_itself_is_removed_once_cleanup_leaves_it_empty() {
    let dir = temp_session_dir("fully-empty");
    tokio::fs::create_dir_all(&dir).await.unwrap();
    tokio::fs::write(dir.join("conv.jsonl"), b"{}")
        .await
        .unwrap();

    delete_session_conversations(&dir.to_string_lossy()).await;

    assert!(tokio::fs::metadata(&dir).await.is_err());
}

// Handler tests against a temp registry and a real repo, matching `ipc::repositories`'s own
// `make_state` pattern exactly.

fn temp_registry_dir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "refract-sessions-lifecycle-registry-test-{label}-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).expect("create temp registry dir");
    dir
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

fn make_repository(id: &str, path: &str) -> Repository {
    Repository {
        id: id.to_string(),
        path: path.to_string(),
        name: "repo".to_string(),
        default_branch: "main".to_string(),
        added_at: "2026-01-01T00:00:00.000Z".to_string(),
        color: None,
    }
}

fn make_session(id: &str, repository_id: &str, worktree_path: &str, branch: &str) -> Session {
    Session {
        id: id.to_string(),
        repository_id: repository_id.to_string(),
        name: "test session".to_string(),
        branch: branch.to_string(),
        base_branch: "main".to_string(),
        worktree_path: worktree_path.to_string(),
        session_dir: None,
        current_conversation: None,
        last_message_count: None,
        last_model: None,
        last_thinking_level: None,
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        last_activity_at: "2026-01-01T00:00:00.000Z".to_string(),
        archived_at: None,
        current_turn_subagents: None,
        stopped_on_request_conversation: None,
        stopped_on_request_at_size: None,
        pinned_model: false,
    }
}

#[tokio::test]
async fn sessions_archive_on_a_session_with_no_live_agent_sets_archived_at() {
    let dir = temp_registry_dir("archive-sets-archived-at");
    let state = make_state(&dir).await;
    state
        .registry
        .lock()
        .await
        .add_repository(make_repository("repo-1", "C:/nowhere/repo"))
        .await
        .expect("add_repository");
    let session = make_session(
        "session-archive",
        "repo-1",
        "C:/nowhere/worktree",
        "feature",
    );
    state
        .registry
        .lock()
        .await
        .add_session(session.clone())
        .await
        .expect("add_session");

    let args = vec![Value::String(session.id.clone())];
    sessions_archive(state.clone(), args)
        .await
        .expect("archive must succeed");

    let archived_at = state
        .registry
        .lock()
        .await
        .get_session(&session.id)
        .expect("session must still exist")
        .archived_at
        .clone();
    assert!(archived_at.is_some());
}

#[tokio::test]
async fn sessions_archive_on_an_unknown_id_returns_not_found() {
    let dir = temp_registry_dir("archive-not-found");
    let state = make_state(&dir).await;
    let args = vec![Value::String("missing-id".to_string())];
    let err = sessions_archive(state, args)
        .await
        .expect_err("unknown id must error");
    assert_eq!(err.code, "not-found");
}

#[tokio::test]
async fn sessions_restore_clears_archived_at_back_to_none() {
    let dir = temp_registry_dir("restore-clears");
    let state = make_state(&dir).await;
    state
        .registry
        .lock()
        .await
        .add_repository(make_repository("repo-1", "C:/nowhere/repo"))
        .await
        .expect("add_repository");
    let mut session = make_session(
        "session-restore",
        "repo-1",
        "C:/nowhere/worktree",
        "feature",
    );
    session.archived_at = Some("2026-01-01T00:00:00.000Z".to_string());
    state
        .registry
        .lock()
        .await
        .add_session(session.clone())
        .await
        .expect("add_session");

    let args = vec![Value::String(session.id.clone())];
    sessions_restore(state.clone(), args)
        .await
        .expect("restore must succeed");

    let archived_at = state
        .registry
        .lock()
        .await
        .get_session(&session.id)
        .expect("session must still exist")
        .archived_at
        .clone();
    assert_eq!(archived_at, None);
}

#[tokio::test]
async fn sessions_recreate_worktree_returns_branch_missing_for_a_deleted_branch() {
    let dir = temp_registry_dir("recreate-branch-missing");
    let state = make_state(&dir).await;
    let repo = init_repo().await;
    state
        .registry
        .lock()
        .await
        .add_repository(make_repository("repo-1", &repo.to_string_lossy()))
        .await
        .expect("add_repository");
    let worktree_path =
        crate::git::worktrees::worktrees_root(&repo).join("vanished-branch-session");
    let session = make_session(
        "session-recreate",
        "repo-1",
        &worktree_path.to_string_lossy(),
        "branch-that-does-not-exist",
    );
    state
        .registry
        .lock()
        .await
        .add_session(session.clone())
        .await
        .expect("add_session");

    let args = vec![Value::String(session.id.clone())];
    let err = sessions_recreate_worktree(state, args)
        .await
        .expect_err("a missing branch must return the custom branch-missing error");
    assert_eq!(err.code, "branch-missing");
    assert!(
        tokio::fs::metadata(&worktree_path).await.is_err(),
        "the worktree folder must never be touched when the branch is gone"
    );
}

/// Closest testable seam for the CRITICAL ordering fix (gate round 1: `shutdown()` before
/// `remove_session_worktree`): this crate has no fake-omp process to drive a genuinely RUNNING
/// `SessionAgent` through `sessions.delete`, so this proves the no-op-shutdown path instead -- a
/// never-started agent's status is `Stopped` both before and after, and `sessions_delete` still
/// succeeds end to end (worktree removed, registry entry gone). A true "shuts down a RUNNING
/// agent first" test needs fake-omp process infrastructure this crate does not have yet (known
/// gap).
#[tokio::test]
async fn sessions_delete_on_a_never_started_session_succeeds_with_a_harmless_no_op_shutdown() {
    let dir = temp_registry_dir("delete-noop-shutdown");
    let state = make_state(&dir).await;
    let repo = init_repo().await;
    state
        .registry
        .lock()
        .await
        .add_repository(make_repository("repo-1", &repo.to_string_lossy()))
        .await
        .expect("add_repository");
    let added = add_worktree_with_generated_name(&repo, "main")
        .await
        .expect("create worktree");
    let session = make_session(
        "session-delete",
        "repo-1",
        &added.worktree_path.to_string_lossy(),
        &added.branch,
    );
    state
        .registry
        .lock()
        .await
        .add_session(session.clone())
        .await
        .expect("add_session");

    let agent = state.session_manager.get_or_create_agent(&session.id);
    assert_eq!(agent.status().await, SessionStatus::Stopped);

    let args = vec![
        Value::String(session.id.clone()),
        serde_json::json!({ "confirmed": true }),
    ];
    sessions_delete(state.clone(), args)
        .await
        .expect("delete must succeed");

    assert_eq!(agent.status().await, SessionStatus::Stopped);
    assert!(tokio::fs::metadata(&added.worktree_path).await.is_err());
    assert!(state
        .registry
        .lock()
        .await
        .get_session(&session.id)
        .is_none());
}

/// `sessions.ts`'s own `resumingIds` busy-lock has no equivalent in this crate yet: `session::
/// start_queue`/`session::termination` (lane R3, issue #786) are both still no-op stubs with no
/// in-flight start/resume marker `sessions_archive`/`sessions_delete` could check, and
/// `SessionAgent`'s own internal `start_lock` (see `agent::conversations`'s own doc comment)
/// only guards a single Session's own concurrent `start()` calls -- it is not exposed as
/// something an IPC handler can query to refuse an archive/delete mid-resume. Add this test for
/// real once `sessions.resume` (lane R3/#786) lands a queryable marker.
#[ignore = "no in-flight start/resume marker exists in this crate yet (lane R3/#786); add this test once sessions.resume lands"]
#[tokio::test]
async fn sessions_archive_refuses_a_session_that_is_mid_start_or_mid_resume() {
    unimplemented!("blocked on lane R3/#786's sessions.resume in-flight marker")
}

/// Gate round 2 (#657/#658): the reclaim hook fires exactly on the success path of both
/// `sessions.archive` and `sessions.delete`, never on a refused/failed call -- a thread-local
/// counter (see `on_worktree_released`'s own doc comment for why thread-local, not a global
/// atomic, is the correct parallel-test-safe choice here) lets each test assert an EXACT call
/// count (`before + 1` on success, `before` unchanged on refusal) with no cross-test flakiness.
#[tokio::test]
async fn sessions_archive_fires_the_worktree_released_hook_on_success() {
    let dir = temp_registry_dir("archive-fires-hook");
    let state = make_state(&dir).await;
    state
        .registry
        .lock()
        .await
        .add_repository(make_repository("repo-1", "C:/nowhere/repo"))
        .await
        .expect("add_repository");
    let session = make_session(
        "session-hook-archive",
        "repo-1",
        "C:/nowhere/worktree",
        "feature",
    );
    state
        .registry
        .lock()
        .await
        .add_session(session.clone())
        .await
        .expect("add_session");

    let before = WORKTREE_RELEASED_HOOK_CALLS.with(|c| c.get());
    let args = vec![Value::String(session.id.clone())];
    sessions_archive(state, args)
        .await
        .expect("archive must succeed");
    let after = WORKTREE_RELEASED_HOOK_CALLS.with(|c| c.get());
    assert_eq!(
        after,
        before + 1,
        "a successful archive must fire the reclaim hook exactly once"
    );
}

#[tokio::test]
async fn sessions_archive_on_an_unknown_id_never_fires_the_hook() {
    let dir = temp_registry_dir("archive-not-found-no-hook");
    let state = make_state(&dir).await;
    let before = WORKTREE_RELEASED_HOOK_CALLS.with(|c| c.get());
    let args = vec![Value::String("missing-id".to_string())];
    let _ = sessions_archive(state, args).await;
    let after = WORKTREE_RELEASED_HOOK_CALLS.with(|c| c.get());
    assert_eq!(
        after, before,
        "a refused archive must never fire the reclaim hook"
    );
}

#[tokio::test]
async fn sessions_delete_fires_the_worktree_released_hook_on_success() {
    let dir = temp_registry_dir("delete-fires-hook");
    let state = make_state(&dir).await;
    let repo = init_repo().await;
    state
        .registry
        .lock()
        .await
        .add_repository(make_repository("repo-1", &repo.to_string_lossy()))
        .await
        .expect("add_repository");
    let added = add_worktree_with_generated_name(&repo, "main")
        .await
        .expect("create worktree");
    let session = make_session(
        "session-hook-delete",
        "repo-1",
        &added.worktree_path.to_string_lossy(),
        &added.branch,
    );
    state
        .registry
        .lock()
        .await
        .add_session(session.clone())
        .await
        .expect("add_session");

    let before = WORKTREE_RELEASED_HOOK_CALLS.with(|c| c.get());
    let args = vec![
        Value::String(session.id.clone()),
        serde_json::json!({ "confirmed": true }),
    ];
    sessions_delete(state, args)
        .await
        .expect("delete must succeed");
    let after = WORKTREE_RELEASED_HOOK_CALLS.with(|c| c.get());
    assert_eq!(
        after,
        before + 1,
        "a successful delete must fire the reclaim hook exactly once"
    );
}

#[tokio::test]
async fn sessions_delete_on_an_unknown_id_never_fires_the_hook() {
    let dir = temp_registry_dir("delete-not-found-no-hook");
    let state = make_state(&dir).await;
    let before = WORKTREE_RELEASED_HOOK_CALLS.with(|c| c.get());
    let args = vec![
        Value::String("missing-id".to_string()),
        serde_json::json!({ "confirmed": true }),
    ];
    let _ = sessions_delete(state, args).await;
    let after = WORKTREE_RELEASED_HOOK_CALLS.with(|c| c.get());
    assert_eq!(
        after, before,
        "a refused delete must never fire the reclaim hook"
    );
}
