// Dispatch of the Session tools Rust answers itself. Split from `router.rs` to keep it small.

use std::sync::Arc;

use serde_json::Value;

use super::router::ToolError;
use super::{
    sessions, sessions_conversations, sessions_conversations_schema, sessions_create,
    sessions_end_schema, sessions_end_tools, sessions_send, sessions_update,
};
use crate::session::agent::SessionAgent;

/// Session tools Rust answers itself: no renderer round trip and no generic approval card.
pub(super) async fn run_native(
    agent: &Arc<SessionAgent>,
    call_id: &str,
    tool: &str,
    args: &Value,
) -> Result<Value, ToolError> {
    match tool {
        sessions::LIST_SESSIONS => sessions::list(agent, args).await,
        sessions::GET_SESSION_STATUS => sessions::get_status(agent, args).await,
        sessions_create::CREATE_SESSION => sessions_create::create(agent, call_id, args).await,
        sessions_update::UPDATE_SESSION => sessions_update::update(agent, call_id, args).await,
        other if sessions_conversations_schema::conv_tool(other).is_some() => {
            let conv = sessions_conversations_schema::conv_tool(other).expect("checked by the guard");
            sessions_conversations::run(agent, call_id, conv, args).await
        }
        other if sessions_end_schema::end_tool(other).is_some() => {
            let end = sessions_end_schema::end_tool(other).expect("checked by the guard");
            sessions_end_tools::run(agent, call_id, end, args).await
        }
        _ => sessions_send::send(agent, args).await,
    }
}
