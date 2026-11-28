// `conversations.tree`, `.rewind`, `.fork`, `.label` and `.abortSummary` (#696): the Conversation tree.
// Rewind and Fork run only while the Session is idle; a Session without a live agent has no tree to read.

use serde_json::{json, Value};

use super::conversations::snapshot_of;
use super::sessions_lifecycle::delete_in_flight;
use super::{
    arg_str, invalid_argument, map_agent_error, not_found, AppState, Dispatcher, HandlerFuture,
    IpcError,
};
use crate::session::SessionAgent;
use std::sync::Arc;

const MAX_ENTRY_ID_CHARS: usize = 256;
const MAX_LABEL_CHARS: usize = 200;

pub fn register(d: &mut Dispatcher) {
    d.register("conversations.tree", conversations_tree);
    d.register("conversations.rewind", conversations_rewind);
    d.register("conversations.fork", conversations_fork);
    d.register("conversations.label", conversations_label);
    d.register("conversations.abortSummary", conversations_abort_summary);
}

async fn agent_for(state: &AppState, id: &str) -> Result<Arc<SessionAgent>, IpcError> {
    delete_in_flight::refuse_if_deleting(id)?;
    if state.registry.lock().await.get_session(id).is_none() {
        return Err(not_found(format!("Session not found: {id}")));
    }
    Ok(state.session_manager.get_or_create_agent(id))
}

pub(crate) async fn tree_core(state: &AppState, id: &str) -> Result<Value, IpcError> {
    let agent = agent_for(state, id).await?;
    agent.conversation_tree().await.map_err(map_agent_error)
}

/// `{ cancelled, editorText, snapshot }`; the snapshot is the rebuilt transcript of the same Conversation.
pub(crate) async fn rewind_core(
    state: &AppState,
    id: &str,
    entry_id: &str,
    summarize: bool,
) -> Result<Value, IpcError> {
    let agent = agent_for(state, id).await?;
    let outcome = agent
        .rewind_conversation(entry_id, summarize)
        .await
        .map_err(map_agent_error)?;
    let snapshot = snapshot_of(state, id).await?;
    Ok(json!({
        "cancelled": outcome.cancelled,
        "editorText": outcome.editor_text,
        "snapshot": snapshot,
    }))
}

/// `{ file, snapshot }`; the snapshot is the new Conversation, and the original stays in the list.
pub(crate) async fn fork_core(
    state: &AppState,
    id: &str,
    entry_id: &str,
) -> Result<Value, IpcError> {
    let agent = agent_for(state, id).await?;
    let file = agent
        .fork_conversation(entry_id)
        .await
        .map_err(map_agent_error)?;
    let snapshot = snapshot_of(state, id).await?;
    Ok(json!({ "file": file, "snapshot": snapshot }))
}

/// An empty `label` clears it.
pub(crate) async fn label_core(
    state: &AppState,
    id: &str,
    entry_id: &str,
    label: &str,
) -> Result<(), IpcError> {
    let agent = agent_for(state, id).await?;
    agent
        .set_entry_label(entry_id, label)
        .await
        .map_err(map_agent_error)
}

pub(crate) async fn abort_summary_core(state: &AppState, id: &str) -> Result<(), IpcError> {
    let agent = agent_for(state, id).await?;
    agent.abort_branch_summary().await.map_err(map_agent_error)
}

/// An id argument OMP would pass on verbatim must at least be a non-empty string of a sane length.
fn entry_id_arg(args: &[Value], index: usize, usage: &str) -> Result<String, IpcError> {
    match arg_str(args, index) {
        Some(id) if !id.trim().is_empty() && id.chars().count() <= MAX_ENTRY_ID_CHARS => {
            Ok(id.to_string())
        }
        _ => Err(invalid_argument(usage.to_string())),
    }
}

fn session_id_arg(args: &[Value], usage: &str) -> Result<String, IpcError> {
    arg_str(args, 0)
        .map(str::to_string)
        .ok_or_else(|| invalid_argument(usage.to_string()))
}

pub fn conversations_tree(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = session_id_arg(&args, "conversations.tree expects a string sessionId")?;
        tree_core(&state, &id).await
    })
}

pub fn conversations_rewind(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let usage = "conversations.rewind expects (sessionId, entryId, summarize?)";
        let id = session_id_arg(&args, usage)?;
        let entry_id = entry_id_arg(&args, 1, usage)?;
        let summarize = match args.get(2) {
            None | Some(Value::Null) => false,
            Some(Value::Bool(flag)) => *flag,
            Some(_) => return Err(invalid_argument(usage.to_string())),
        };
        rewind_core(&state, &id, &entry_id, summarize).await
    })
}

pub fn conversations_fork(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let usage = "conversations.fork expects (sessionId, entryId)";
        let id = session_id_arg(&args, usage)?;
        let entry_id = entry_id_arg(&args, 1, usage)?;
        fork_core(&state, &id, &entry_id).await
    })
}

pub fn conversations_label(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let usage = "conversations.label expects (sessionId, entryId, label)";
        let id = session_id_arg(&args, usage)?;
        let entry_id = entry_id_arg(&args, 1, usage)?;
        let label = arg_str(&args, 2)
            .filter(|l| l.chars().count() <= MAX_LABEL_CHARS)
            .ok_or_else(|| {
                invalid_argument(format!(
                    "{usage}; label is at most {MAX_LABEL_CHARS} characters"
                ))
            })?;
        label_core(&state, &id, &entry_id, label).await?;
        Ok(Value::Null)
    })
}

pub fn conversations_abort_summary(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = session_id_arg(
            &args,
            "conversations.abortSummary expects a string sessionId",
        )?;
        abort_summary_core(&state, &id).await?;
        Ok(Value::Null)
    })
}

#[cfg(test)]
#[path = "conversations_tree.test.rs"]
mod tests;
