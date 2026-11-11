// `agentTools.result`: the renderer's answer to an `agent-tools:call`. The Session is the one the
// renderer names, but the call id only resolves inside that Session's own router.

use serde_json::{json, Value};

use super::{invalid_argument, not_found, AppState, Dispatcher, HandlerFuture};

pub fn register(d: &mut Dispatcher) {
    d.register("agentTools.result", agent_tools_result);
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
        Ok(json!({ "accepted": agent.tool_router().answer(call_id, reply) }))
    })
}
