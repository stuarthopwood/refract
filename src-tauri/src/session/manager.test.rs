// Issue #740 (lane RM): `SessionManager::apply_role_change`'s own sweep-rule tests, split into
// this sibling file (`.test.rs` naming, excluded from `check:file-size`'s cap the same way
// `commands.test.rs` already is) purely to keep `manager.rs` itself under this build's
// 600-line-per-file cap -- no behaviour here, only coverage for "which Sessions follow which
// role" and the apply/skip rules the code review gate asked for.

use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex as AsyncMutex;

use crate::events::EventSink;
use crate::session::{SessionManager, SessionStatus};
use crate::store::registry::{RegistryStore, Repository, Session};
use crate::store::settings::SettingsStore;

fn temp_dir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "refract-session-manager-role-sweep-test-{label}-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn make_session(id: &str, repository_id: &str, worktree_path: &std::path::Path) -> Session {
    Session {
        id: id.to_string(),
        repository_id: repository_id.to_string(),
        name: "Test Session".to_string(),
        branch: "test-branch".to_string(),
        base_branch: "main".to_string(),
        worktree_path: worktree_path.to_string_lossy().to_string(),
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
    }
}

/// Builds a bare `SessionManager` over a fresh scratch registry/settings pair, with one
/// `Session` row registered (no real git worktree needed: these tests never start the agent's
/// own `omp` process, only manipulate its in-memory state).
async fn make_manager_with_session(dir: &std::path::Path, session_id: &str) -> Arc<SessionManager> {
    let mut registry_store = RegistryStore::open(dir).await.expect("open registry");
    registry_store
        .add_repository(Repository {
            id: "repo-1".to_string(),
            path: dir.to_string_lossy().to_string(),
            name: "pinion".to_string(),
            default_branch: "main".to_string(),
            added_at: "2026-01-01T00:00:00.000Z".to_string(),
        })
        .await
        .expect("add repository");
    registry_store
        .add_session(make_session(session_id, "repo-1", dir))
        .await
        .expect("add session");
    let registry = Arc::new(AsyncMutex::new(registry_store));
    let settings = Arc::new(AsyncMutex::new(
        SettingsStore::open(dir).await.expect("open settings"),
    ));
    let app_handle_slot: Arc<StdMutex<Option<tauri::AppHandle>>> = Arc::new(StdMutex::new(None));
    let events = EventSink::new(app_handle_slot, registry.clone());
    SessionManager::new(registry, settings, events)
}

/// Gate-fix (HIGH, tests, #740): "which Sessions follow which role" and the apply/skip rules --
/// a Session pinned by hand (#454) is skipped and named, never moved.
#[tokio::test]
async fn apply_role_change_skips_a_pinned_session() {
    let dir = temp_dir("pinned");
    let manager = make_manager_with_session(&dir, "s1").await;
    let agent = manager.get_or_create_agent("s1");
    // Represents an OPEN, idle Session (pinning is meaningless for one that was never started)
    // -- the default status for a freshly `get_or_create_agent`'d agent is `Stopped`, which the
    // sweep already skips for an unrelated reason (tested separately below).
    agent.set_status(SessionStatus::Idle, None, None).await;
    agent
        .with_model_state(|s| {
            s.pinned = true;
            s.current_role = Some("default".to_string());
        })
        .await;
    let summary = manager.apply_role_change("default").await;
    assert_eq!(summary.skipped_pinned, vec!["Test Session".to_string()]);
    assert!(summary.moved.is_empty());
    assert!(summary.queued.is_empty());
    assert!(summary.failed.is_empty());
}

/// A Session on a DIFFERENT role is untouched (no bucket at all), not merely "not moved".
#[tokio::test]
async fn apply_role_change_ignores_a_session_on_a_different_role() {
    let dir = temp_dir("other-role");
    let manager = make_manager_with_session(&dir, "s1").await;
    let agent = manager.get_or_create_agent("s1");
    agent.set_status(SessionStatus::Idle, None, None).await;
    agent
        .with_model_state(|s| {
            s.pinned = false;
            s.current_role = Some("smol".to_string());
        })
        .await;
    let summary = manager.apply_role_change("default").await;
    assert!(summary.moved.is_empty());
    assert!(summary.queued.is_empty());
    assert!(summary.skipped_pinned.is_empty());
    assert!(summary.skipped_stopped.is_empty());
    assert!(summary.failed.is_empty());
}

/// A working Session is queued for its own next settle, never refused (#740's own decided
/// design) -- and the queue happens atomically with the status read
/// (`queue_role_reapply_or_ready`), so `State.pending_role_reapply` is actually set, not merely
/// reported.
#[tokio::test]
async fn apply_role_change_queues_a_working_session() {
    let dir = temp_dir("working");
    let manager = make_manager_with_session(&dir, "s1").await;
    let agent = manager.get_or_create_agent("s1");
    agent
        .with_model_state(|s| {
            s.pinned = false;
            s.current_role = Some("default".to_string());
        })
        .await;
    agent.set_status(SessionStatus::Working, None, None).await;
    let summary = manager.apply_role_change("default").await;
    assert_eq!(summary.queued, vec!["Test Session".to_string()]);
    assert!(summary.moved.is_empty());
    let pending = agent
        .with_model_state(|s| s.pending_role_reapply.clone())
        .await;
    assert_eq!(pending, Some("default".to_string()));
}

/// Gate-fix (HIGH, tests, #740): a Session with no live agent (never started this run -- the
/// default status for a freshly `get_or_create_agent`'d Session) is skipped, never counted as
/// failed -- it resumes its own saved model on its next real start.
#[tokio::test]
async fn apply_role_change_skips_a_never_started_session_as_stopped_not_failed() {
    let dir = temp_dir("stopped");
    let manager = make_manager_with_session(&dir, "s1").await;
    let _agent = manager.get_or_create_agent("s1"); // never started: status stays `Stopped`
    let summary = manager.apply_role_change("default").await;
    assert_eq!(summary.skipped_stopped, vec!["Test Session".to_string()]);
    assert!(summary.moved.is_empty());
    assert!(summary.queued.is_empty());
    assert!(summary.failed.is_empty());
}
