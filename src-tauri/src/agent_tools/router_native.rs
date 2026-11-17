// Dispatch of the Session tools Rust answers itself. Split from `router.rs` to keep it small.

use std::sync::Arc;

use serde_json::Value;

use super::router::ToolError;
use super::{sessions, sessions_create, sessions_send, sessions_update};
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
        _ => sessions_send::send(agent, args).await,
    }
}
