// Test module for `sessions_lifecycle.rs`, split out for the 600-line cap and included via
// `#[path]`. Scratch dirs are left in the OS temp folder.

use super::*;
use crate::events::EventSink;
use crate::git::test_support::init_repo;
use crate::session::{SessionManager, SessionStatus};
use crate::store::registry::{RegistryStore, Repository};
use crate::store::settings::SettingsStore;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex as AsyncMutex;

// `is_strict_descendant_of_omp_sessions`: pure path function; no git/tokio runtime needed.

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

/// A sibling sharing a string prefix with the root (`sessions-evil` next to `sessions`) must not
/// pass; the function appends `MAIN_SEPARATOR` before comparing.
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

// `delete_session_conversations`: real temp dir under `test_scratch` (removed when the test thread ends).

fn temp_session_dir(label: &str) -> std::path::PathBuf {
    crate::test_scratch::path(format!(
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

// Handler tests against a temp registry and a real repo (`make_state` pattern).

fn temp_registry_dir(label: &str) -> std::path::PathBuf {
    let dir = crate::test_scratch::path(format!(
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
        hidden_at: None,
        paused_held: None,
        current_turn_subagents: None,
        stopped_on_request_conversation: None,
        stopped_on_request_at_size: None,
        pinned_model: false,
        origin_issue: None,
        parent_session_id: None,
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
async fn sessions_restore_into_a_full_parent_is_child_limit_until_a_slot_frees() {
    let dir = temp_registry_dir("restore-child-limit");
    let state = make_state(&dir).await;
    state
        .registry
        .lock()
        .await
        .add_repository(make_repository("repo-1", "C:/nowhere/repo"))
        .await
        .expect("add_repository");
    let mut rows = vec![make_session("parent", "repo-1", "C:/nowhere/p", "p")];
    for n in 0..5 {
        let mut kid = make_session(
            &format!("kid-{n}"),
            "repo-1",
            &format!("C:/nowhere/k{n}"),
            &format!("k{n}"),
        );
        kid.parent_session_id = Some("parent".to_string());
        rows.push(kid);
    }
    rows[5].archived_at = Some("2026-01-01T00:00:00.000Z".to_string());
    for row in rows {
        state
            .registry
            .lock()
            .await
            .add_session(row)
            .await
            .expect("add_session");
    }

    let err = sessions_restore(state.clone(), vec![Value::String("kid-4".to_string())])
        .await
        .expect_err("a fifth live child must be refused");
    assert_eq!(err.code, "child-limit");
    assert!(state
        .registry
        .lock()
        .await
        .get_session("kid-4")
        .unwrap()
        .archived_at
        .is_some());

    state
        .registry
        .lock()
        .await
        .update_session(
            "kid-0",
            SessionPatch {
                archived_at: Some(Some("2026-01-02T00:00:00.000Z".to_string())),
                ..Default::default()
            },
        )
        .await
        .expect("archive kid-0");
    sessions_restore(state.clone(), vec![Value::String("kid-4".to_string())])
        .await
        .expect("a free slot allows the restore");
}

#[tokio::test]
async fn sessions_restore_waits_for_the_project_gate() {
    let dir = temp_registry_dir("restore-gate");
    let state = make_state(&dir).await;
    let mut store = state.registry.lock().await;
    store
        .add_repository(make_repository("repo-1", "C:/nowhere/repo"))
        .await
        .expect("add_repository");
    let mut row = make_session("s1", "repo-1", "C:/nowhere/s1", "s1");
    row.archived_at = Some("2026-01-01T00:00:00.000Z".to_string());
    store.add_session(row).await.expect("add_session");
    drop(store);

    let held = crate::agent_tools::tree_gate::lock("repo-1").await;
    let task = tokio::spawn(sessions_restore(
        state.clone(),
        vec![Value::String("s1".to_string())],
    ));
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let archived = |state: &AppState| {
        let state = state.clone();
        async move { state.registry.lock().await.get_session("s1").unwrap().archived_at.is_some() }
    };
    assert!(archived(&state).await, "restore must wait for the gate");
    drop(held);
    task.await.unwrap().expect("restore");
    assert!(!archived(&state).await);
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

/// `sessions_delete` returns once its checks pass and the removal runs on in the background.
async fn wait_until_settled(id: &str) {
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        while delete_in_flight::is_deleting(id) {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the background removal must settle");
}

/// Proves the no-op-shutdown path (`shutdown()` before `remove_session_worktree`): a never-started
/// agent is `Stopped` before and after, and delete still succeeds. No fake omp process exists to
/// test a RUNNING agent.
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
    wait_until_settled(&session.id).await;

    assert_eq!(agent.status().await, SessionStatus::Stopped);
    assert!(tokio::fs::metadata(&added.worktree_path).await.is_err());
    assert!(state
        .registry
        .lock()
        .await
        .get_session(&session.id)
        .is_none());
}

/// Known gap: no queryable in-flight resume marker exists for archive/delete to refuse on; add a
/// test once `sessions.resume` (#786) lands one.
#[ignore = "no in-flight start/resume marker exists in this crate yet (lane R3/#786); add this test once sessions.resume lands"]
#[tokio::test]
async fn sessions_archive_refuses_a_session_that_is_mid_start_or_mid_resume() {
    unimplemented!("blocked on lane R3/#786's sessions.resume in-flight marker")
}

/// The reclaim hook fires exactly on the success path of `sessions.archive` and `sessions.delete`
/// (#657/#658). A thread-local counter keeps exact counts parallel-test-safe.
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
    wait_until_settled(&session.id).await;
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
    wait_until_settled("missing-id").await;
    let after = WORKTREE_RELEASED_HOOK_CALLS.with(|c| c.get());
    assert_eq!(
        after, before,
        "a refused delete must never fire the reclaim hook"
    );
}
