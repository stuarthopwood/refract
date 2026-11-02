// Argument-parsing wrapper over `session::working_mode`.

use serde_json::Value;

use crate::session::working_mode;

use super::{invalid_argument, not_found, AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("workingMode.set", working_mode_set);
}

/// Sets the Session's working mode (Interactive, Plan, Grill, Away).
pub fn working_mode_set(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let (Some(session_id), Some(mode)) = (
            args.first().and_then(Value::as_str),
            args.get(1).and_then(Value::as_str),
        ) else {
            return Err(invalid_argument(
                "workingMode.set expects (sessionId, mode) strings",
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
        working_mode::set_mode(&agent, mode)
            .await
            .map_err(|err| IpcError::new(err.code, err.message))
    })
}
