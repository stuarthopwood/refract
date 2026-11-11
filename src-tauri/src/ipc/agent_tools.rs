// `agentTools.result` and `agentTools.started`: the renderer's answers to an `agent-tools:call`.
// The Session is the one the renderer names, but the call id only resolves inside that Session's
// own router.

use serde_json::{json, Value};

use super::{invalid_argument, not_found, AppState, Dispatcher, HandlerFuture};
use crate::agent_tools::router::ToolRouter;

pub fn register(d: &mut Dispatcher) {
    d.register("agentTools.result", agent_tools_result);
    d.register("agentTools.started", agent_tools_started);
}

fn agent_tools_result(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let (Some(session_id), Some(call_id), Some(reply)) = (
            args.first().and_then(Value::as_str),
            args.get(1).and_then(Value::as_str),
            args.get(2),
        ) else {
            return Err(invalid_argument(
                "agentTools.result expects (sessionId, callId, reply)",
            ));
        };
        let accepted = with_router(&state, session_id, |router| {
            router.answer(call_id, reply)
        })
        .await?;
        Ok(json!({ "accepted": accepted }))
    })
}

fn agent_tools_started(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let (Some(session_id), Some(call_id)) = (
            args.first().and_then(Value::as_str),
            args.get(1).and_then(Value::as_str),
        ) else {
            return Err(invalid_argument(
                "agentTools.started expects (sessionId, callId)",
            ));
        };
        let accepted = with_router(&state, session_id, |router| router.started(call_id)).await?;
        Ok(json!({ "accepted": accepted }))
    })
}

async fn with_router(
    state: &AppState,
    session_id: &str,
    f: impl FnOnce(&ToolRouter) -> bool,
) -> Result<bool, super::IpcError> {
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
    Ok(f(agent.tool_router()))
}
