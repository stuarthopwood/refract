// Shared fixture for the subagents tests: a real `SessionAgent` over a scratch registry and data folder.

use std::path::PathBuf;
use std::sync::Arc;

use crate::session::agent::SessionAgent;
use crate::store::registry::Session;

/// A Session's agent plus the scratch data folder it lives in.
pub(in crate::session) struct AgentFixture {
    pub agent: Arc<SessionAgent>,
    pub manager: Arc<crate::session::manager::SessionManager>,
    pub id: String,
    pub dir: PathBuf,
}

/// Builds an agent for a fresh Session; `visible` decides whether `subagents:update` is pushed live.
pub(in crate::session) async fn agent_fixture(visible: bool) -> AgentFixture {
    let id = format!("session-synth-{}", uuid::Uuid::new_v4());
    let dir = crate::test_scratch::path(format!("refract-synth-hook-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let mut registry_store = crate::store::registry::RegistryStore::open(&dir)
        .await
        .unwrap();
    registry_store
        .add_repository(crate::store::registry::Repository {
            id: "repo-synth".to_string(),
            path: dir.join("repo").to_string_lossy().into_owned(),
            name: "repo".to_string(),
            default_branch: "main".to_string(),
            added_at: "2026-11-26T00:00:00.000Z".to_string(),
            color: None,
        })
        .await
        .unwrap();
    registry_store
        .add_session(Session {
            id: id.clone(),
            kind: crate::store::session_kind::SessionKind::Project,
            repository_id: Some("repo-synth".to_string()),
            name: "test".to_string(),
            branch: Some("feat/test".to_string()),
            base_branch: Some("main".to_string()),
            worktree_path: Some(dir.join("worktree").to_string_lossy().into_owned()),
            session_dir: None,
            current_conversation: None,
            last_message_count: None,
            last_model: None,
            last_thinking_level: None,
            created_at: "2026-11-26T00:00:00.000Z".to_string(),
            last_activity_at: "2026-11-26T00:00:00.000Z".to_string(),
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
    let agent = manager.get_or_create_agent(&id);
    if visible {
        manager.set_visible(vec![id.clone()]).await;
    }
    AgentFixture {
        agent,
        manager,
        id,
        dir,
    }
}

/// Makes the agent `Idle` (an unlaunched one is `Stopped`, which the aggregate skips) holding one
/// running subagent, so its Session has a group in `agents:update`.
pub(in crate::session) async fn seed_running_subagent(agent: &SessionAgent) {
    use super::{SummaryEntry, SummaryStatus};
    agent
        .set_status(crate::session::SessionStatus::Idle, None, None)
        .await;
    agent
        .with_subagents_state(|s| {
            s.summaries.push(SummaryEntry {
                id: "t1:a".into(),
                tool_call_id: "t1".into(),
                spec_index: 0,
                name_or_task: "a".into(),
                name: None,
                task_summary: None,
                status: SummaryStatus::Running,
                started_at: 1,
                duration_ms: None,
                background: false,
                role: None,
                overall_goal: None,
                card_summary: None,
                files_touched: Vec::new(),
                recent_steps: Vec::new(),
                stage_key: "m1".into(),
                turn: 0,
            });
        })
        .await;
}
