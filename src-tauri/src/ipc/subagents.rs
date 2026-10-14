// IPC handlers for `chat.setVisibleSubagent`/`chat.subagentSnapshot` (lane R5, issue #788).
// `src/shared/ipc.ts`'s own doc comments: `setVisibleSubagent` tells main which subagent's
// stream to forward as `subagent:patch` (mirrors `sessions.setVisible`'s own shape, `null` stops
// forwarding); `subagentSnapshot` is the full current stream for one subagent, for when the
// panel first selects it, before any patch arrives -- `not-found` when `subagentId` does not
// match a `SubagentSummary` of the current state. Split from `ipc/chat.rs` (issue #784,
// "Pre-declare per-lane Rust files"; `chat.rs`'s own header already carves these two channels out
// of its scope) so lane R5 is the only lane that ever edits this file.

use serde_json::Value;

use crate::session::subagents;

use super::{arg_str, invalid_argument, not_found, AppState, Dispatcher, HandlerFuture};

pub fn register(d: &mut Dispatcher) {
    d.register("chat.setVisibleSubagent", chat_set_visible_subagent);
    d.register("chat.subagentSnapshot", chat_subagent_snapshot);
}

pub fn chat_set_visible_subagent(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(session_id) = arg_str(&args, 0) else {
            return Err(invalid_argument(
                "chat.setVisibleSubagent expects (sessionId, subagentId | null)",
            ));
        };
        // `subagentId` is `string | null` (`src/shared/ipc.ts`): a non-string, non-null second
        // argument is still rejected outright, matching every other handler's own shape check.
        let subagent_id = match args.get(1) {
            None | Some(Value::Null) => None,
            Some(Value::String(id)) => Some(id.clone()),
            Some(_) => {
                return Err(invalid_argument(
                    "chat.setVisibleSubagent expects (sessionId, subagentId | null)",
                ));
            }
        };
        if state
            .registry
            .lock()
            .await
            .get_session(session_id)
            .is_none()
        {
            return Err(not_found(format!("Session not found: {session_id}")));
        }
        let agent = state.session_manager.get_or_create_agent(session_id);
        subagents::set_visible(&agent, subagent_id).await;
        Ok(Value::Null)
    })
}

pub fn chat_subagent_snapshot(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(session_id) = arg_str(&args, 0) else {
            return Err(invalid_argument(
                "chat.subagentSnapshot expects (sessionId, subagentId) strings",
            ));
        };
        let Some(subagent_id) = arg_str(&args, 1) else {
            return Err(invalid_argument(
                "chat.subagentSnapshot expects (sessionId, subagentId) strings",
            ));
        };
        if state
            .registry
            .lock()
            .await
            .get_session(session_id)
            .is_none()
        {
            return Err(not_found(format!("Session not found: {session_id}")));
        }
        let agent = state.session_manager.get_or_create_agent(session_id);
        match subagents::snapshot(&agent, subagent_id).await {
            Some(items) => Ok(Value::Array(items)),
            None => Err(not_found(format!(
                "chat.subagentSnapshot: no subagent {subagent_id} for Session {session_id}"
            ))),
        }
    })
}
