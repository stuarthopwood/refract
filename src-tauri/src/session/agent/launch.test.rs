// Unit tests for `launch.rs`, loaded via `#[path]`: the deleting-worktree guard on start.
use std::sync::Arc;

use crate::ipc::sessions_lifecycle::delete_in_flight;
use crate::session::agent::SessionAgent;
use crate::store::registry::Session;

/// The worktree directory is never created, so a start that passes the guard stops at
/// `worktree-missing` and never spawns a process.
async fn agent_for(session_id: &str) -> Arc<SessionAgent> {
    let dir = crate::test_scratch::path(format!("refract-launch-test-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let mut registry_store = crate::store::registry::RegistryStore::open(&dir)
        .await
        .unwrap();
    registry_store
        .add_repository(crate::store::registry::Repository {
            id: "repo-missing".to_string(),
            path: dir.join("repo").to_string_lossy().into_owned(),
            name: "repo".to_string(),
            default_branch: "main".to_string(),
            added_at: "2026-10-14T00:00:00.000Z".to_string(),
            color: None,
        })
        .await
        .unwrap();
    registry_store
        .add_session(Session {
            id: session_id.to_string(),
            repository_id: "repo-missing".to_string(),
            name: "test".to_string(),
            branch: "feat/test".to_string(),
            base_branch: "main".to_string(),
            worktree_path: dir.join("worktree").to_string_lossy().into_owned(),
            session_dir: None,
            current_conversation: None,
            last_message_count: None,
            last_model: None,
            last_thinking_level: None,
            created_at: "2026-10-14T00:00:00.000Z".to_string(),
            last_activity_at: "2026-10-14T00:00:00.000Z".to_string(),
            archived_at: None,
            hidden_at: None,
            paused_held: None,
            current_turn_subagents: None,
            stopped_on_request_conversation: None,
            stopped_on_request_at_size: None,
            pinned_model: false,
            origin_issue: None,
            parent_session_id: None,
        })
        .await
        .unwrap();
    let registry = Arc::new(tokio::sync::Mutex::new(registry_store));
    let settings = Arc::new(tokio::sync::Mutex::new(
        crate::store::settings::SettingsStore::open(&dir)
            .await
            .unwrap(),
    ));
    let events =
        crate::events::EventSink::new(Arc::new(std::sync::Mutex::new(None)), registry.clone());
    let manager = crate::session::manager::SessionManager::new(registry, settings, events);
    manager.get_or_create_agent(session_id)
}

#[tokio::test]
async fn start_is_refused_while_the_worktree_is_being_deleted() {
    let id = format!("session-start-busy-{}", uuid::Uuid::new_v4());
    let agent = agent_for(&id).await;
    let _claim = delete_in_flight::claim(&id).unwrap();

    let err = agent.start().await.unwrap_err();
    assert_eq!(err.code, "worktree-busy");
    let err = agent.start_with_conversation(None).await.unwrap_err();
    assert_eq!(err.code, "worktree-busy");
}

#[tokio::test]
async fn start_unchecked_is_not_refused_by_the_deleting_claim() {
    let id = format!("session-restart-{}", uuid::Uuid::new_v4());
    let agent = agent_for(&id).await;
    let _claim = delete_in_flight::claim(&id).unwrap();

    let err = agent.start_unchecked().await.unwrap_err();
    assert_ne!(err.code, "worktree-busy");
}
