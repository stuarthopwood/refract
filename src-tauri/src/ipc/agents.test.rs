// Tests for `agents.rs`.

use super::*;
use crate::events::EventSink;
use crate::session::SessionManager;
use crate::store::registry::{RegistryStore, Repository, Session};
use crate::store::settings::SettingsStore;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex as AsyncMutex;

async fn make_state(label: &str) -> AppState {
    let dir = crate::test_scratch::path(format!(
        "refract-agents-snapshot-test-{label}-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    let registry = RegistryStore::open(&dir).await.expect("open registry");
    let settings = SettingsStore::open(&dir).await.expect("open settings");
    let registry = Arc::new(AsyncMutex::new(registry));
    let settings = Arc::new(AsyncMutex::new(settings));
    let app_handle_slot: Arc<StdMutex<Option<tauri::AppHandle>>> = Arc::new(StdMutex::new(None));
    let events = EventSink::new(app_handle_slot.clone(), registry.clone());
    let session_manager = SessionManager::new(registry.clone(), settings.clone(), events);
    AppState {
        data_dir: dir,
        registry,
        settings,
        app_handle: app_handle_slot,
        session_manager,
    }
}

fn make_session(id: &str) -> Session {
    Session {
        id: id.to_string(),
        kind: crate::store::session_kind::SessionKind::Project,
        repository_id: Some("repo-1".to_string()),
        name: "snapshot session".to_string(),
        branch: Some("feat/agents".to_string()),
        base_branch: Some("main".to_string()),
        worktree_path: Some("agents-worktree".to_string()),
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
async fn agents_snapshot_is_registered_and_returns_empty_groups_with_nothing_running() {
    let state = make_state("empty").await;
    let mut dispatcher = Dispatcher::new();
    register(&mut dispatcher);

    let envelope = dispatcher.dispatch("agents.snapshot", state, vec![]).await;

    assert_eq!(envelope, json!({ "ok": true, "value": { "groups": [] } }));
}

#[tokio::test]
async fn agents_snapshot_returns_the_same_groups_the_aggregate_pushes() {
    let state = make_state("running").await;
    let repo = crate::git::test_support::init_repo().await;
    state
        .registry
        .lock()
        .await
        .add_repository(Repository {
            id: "repo-1".to_string(),
            path: repo.to_string_lossy().into_owned(),
            name: "repo".to_string(),
            default_branch: "main".to_string(),
            added_at: "2026-01-01T00:00:00.000Z".to_string(),
            color: None,
        })
        .await
        .expect("add_repository");
    state
        .registry
        .lock()
        .await
        .add_session(make_session("session-agents-pull"))
        .await
        .expect("add_session");
    state
        .session_manager
        .seed_agents_group("session-agents-pull")
        .await;

    let value = agents_snapshot(state.clone(), vec![])
        .await
        .expect("snapshot must succeed");

    let groups = value["groups"].as_array().expect("groups array");
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0]["sessionId"], "session-agents-pull");
    assert_eq!(groups[0]["subagents"][0]["status"], "running");
    assert_eq!(
        value["groups"],
        state.session_manager.agents_snapshot().await
    );
}
