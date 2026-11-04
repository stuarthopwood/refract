// `tokenGuard.get/set/reset/resetAll/dismissThresholdsReset`. No path or file content comes from the renderer.
// A change applies to the next launched Session.

use serde_json::{json, Value};

use crate::omp::token_guard::values::{self, ValueMap};

use super::{invalid_argument, AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("tokenGuard.get", token_guard_get);
    d.register("tokenGuard.set", token_guard_set);
    d.register("tokenGuard.reset", token_guard_reset);
    d.register("tokenGuard.resetAll", token_guard_reset_all);
    d.register(
        "tokenGuard.dismissThresholdsReset",
        token_guard_dismiss_thresholds_reset,
    );
    d.register("tokenGuard.handoff", token_guard_handoff);
}

/// `tokenGuard.handoff`: a refused or failed hand-off is a result, not an IPC error.
fn token_guard_handoff(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(session_id) = args.first().and_then(Value::as_str).map(str::to_string) else {
            return Err(invalid_argument(
                "tokenGuard.handoff expects a string sessionId",
            ));
        };
        if state
            .registry
            .lock()
            .await
            .get_session(&session_id)
            .is_none()
        {
            return Err(super::not_found(format!("Session not found: {session_id}")));
        }
        let agent = state.session_manager.get_or_create_agent(&session_id);
        Ok(match agent.hand_off().await {
            Ok(()) => json!({ "ok": true }),
            Err(err) => json!({ "ok": false, "reason": err.message }),
        })
    })
}

fn snapshot(values: &ValueMap) -> Value {
    json!({ "values": values::to_object(values), "defaults": values::to_object(&values::defaults()) })
}

fn key_arg(args: &[Value], channel: &str) -> Result<String, IpcError> {
    args.first()
        .and_then(|arg| arg.get("key"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| invalid_argument(format!("{channel} expects {{ key }}")))
}

/// Only reports the migration notice: screens other than Settings > Advanced also load, and must
/// not spend it.
fn token_guard_get(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let mut result = snapshot(&values::load(&state.data_dir).await);
        result["thresholdsReset"] = json!(values::thresholds_reset_pending(&state.data_dir).await);
        Ok(result)
    })
}

fn token_guard_dismiss_thresholds_reset(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        values::dismiss_thresholds_reset(&state.data_dir)
            .await
            .map_err(invalid_argument)?;
        Ok(Value::Null)
    })
}

fn token_guard_set(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let key = key_arg(&args, "tokenGuard.set")?;
        let value = args
            .first()
            .and_then(|arg| arg.get("value"))
            .cloned()
            .ok_or_else(|| invalid_argument("tokenGuard.set expects { key, value }"))?;
        let updated = values::set(&state.data_dir, &key, value)
            .await
            .map_err(invalid_argument)?;
        Ok(snapshot(&updated))
    })
}

fn token_guard_reset(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let key = key_arg(&args, "tokenGuard.reset")?;
        let updated = values::reset(&state.data_dir, &key)
            .await
            .map_err(invalid_argument)?;
        Ok(snapshot(&updated))
    })
}

fn token_guard_reset_all(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let updated = values::reset_all(&state.data_dir)
            .await
            .map_err(invalid_argument)?;
        Ok(snapshot(&updated))
    })
}
