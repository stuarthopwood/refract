// `sessions.openPersonalAgent`: returns the singleton Personal Agent, creating it on first call.
// It needs no Project, repository or branch and creates no Worktree (spec 133, FR-009, FR-011).

use serde_json::Value;

use super::{map_registry_error, now_iso8601, AppState, Dispatcher, HandlerFuture};
use crate::store::registry::Session;
use crate::store::session_kind::SessionKind;

pub const PERSONAL_AGENT_NAME: &str = "My Agent";

pub fn register(d: &mut Dispatcher) {
    d.register("sessions.openPersonalAgent", sessions_open_personal_agent);
}

pub fn sessions_open_personal_agent(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        // One lock across the lookup and the insert, so two concurrent opens cannot both create it.
        let mut registry = state.registry.lock().await;
        let existing = registry
            .snapshot()
            .sessions
            .into_iter()
            .find(Session::is_personal);
        let session = match existing {
            Some(session) => session,
            None => {
                let now = now_iso8601();
                let session = new_personal_session(now);
                registry
                    .add_session(session.clone())
                    .await
                    .map_err(map_registry_error)?;
                session
            }
        };
        Ok(serde_json::to_value(session).expect("Session is always JSON-serialisable"))
    })
}

fn new_personal_session(now: String) -> Session {
    Session {
        id: uuid::Uuid::new_v4().to_string(),
        kind: SessionKind::Personal,
        repository_id: None,
        name: PERSONAL_AGENT_NAME.to_string(),
        branch: None,
        base_branch: None,
        worktree_path: None,
        session_dir: None,
        current_conversation: None,
        last_message_count: None,
        last_model: None,
        last_thinking_level: None,
        created_at: now.clone(),
        last_activity_at: now,
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
