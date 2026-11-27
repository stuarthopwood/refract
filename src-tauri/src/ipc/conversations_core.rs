// The start-new and switch actions behind `conversations.startNew` and `conversations.open`,
// callable without IPC arguments so the agent tools share the exact same gates.

use super::conversations::{list_conversations, same_file};
use super::sessions_lifecycle::delete_in_flight;
use super::{invalid_argument, map_agent_error, not_found, AppState, IpcError};
use crate::session::SessionStatus;

/// A `stopped` Session starts on a new Conversation; a live one starts it in place.
pub(crate) async fn start_new_core(state: &AppState, id: &str) -> Result<(), IpcError> {
    delete_in_flight::refuse_if_deleting(id)?;
    if state.registry.lock().await.get_session(id).is_none() {
        return Err(not_found(format!("Session not found: {id}")));
    }
    let agent = state.session_manager.get_or_create_agent(id);
    let started = if agent.status().await == SessionStatus::Stopped {
        agent.start_with_conversation(None).await
    } else {
        agent.start_new_conversation().await
    };
    started.map_err(map_agent_error)
}

/// `file` must be one of this Session's own Conversations, never a free path. Switching to the
/// current Conversation reloads it, as `conversations.open` always has.
pub(crate) async fn switch_core(state: &AppState, id: &str, file: &str) -> Result<(), IpcError> {
    delete_in_flight::refuse_if_deleting(id)?;
    let session = state
        .registry
        .lock()
        .await
        .get_session(id)
        .cloned()
        .ok_or_else(|| not_found(format!("Session not found: {id}")))?;
    let own_conversations = list_conversations(
        session.session_dir.as_deref(),
        session.current_conversation.as_deref(),
        None,
        false,
    )
    .await;
    let Some(matched) = own_conversations
        .into_iter()
        .find(|c| same_file(&c.file, file))
    else {
        return Err(invalid_argument(
            "conversations.open file must be one of this Session's own Conversations",
        ));
    };
    let agent = state.session_manager.get_or_create_agent(id);
    let opened = if agent.status().await == SessionStatus::Stopped {
        agent.start_with_conversation(Some(matched.file)).await
    } else {
        agent.open_conversation(matched.file).await
    };
    opened.map_err(map_agent_error)
}

#[cfg(test)]
#[path = "conversations_core.test.rs"]
mod tests;
