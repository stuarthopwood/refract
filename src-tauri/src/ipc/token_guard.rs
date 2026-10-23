// Token guard channels (#1212, spec 021, contracts/ipc.md): `tokenGuard.get/set/reset` over the
// Refract-owned overlay values. Plain JSON in and out; no path or file content comes from the
// renderer. A change applies to the next launched Session (the overlay is rewritten per launch).

use serde_json::{json, Value};

use crate::omp::token_guard::values::{self, ValueMap};

use super::{invalid_argument, AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("tokenGuard.get", token_guard_get);
    d.register("tokenGuard.set", token_guard_set);
    d.register("tokenGuard.reset", token_guard_reset);
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

fn token_guard_get(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move { Ok(snapshot(&values::load(&state.data_dir).await)) })
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
