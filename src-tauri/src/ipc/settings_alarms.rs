// IPC handlers for `settings.upsertAlarm` and `settings.deleteAlarm` (#1426).
use serde_json::Value;

use crate::shell::alarms::wake_scheduler;
use crate::store::settings::Alarm;

use super::{arg_str, invalid_argument, AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("settings.upsertAlarm", settings_upsert_alarm);
    d.register("settings.deleteAlarm", settings_delete_alarm);
}

fn parse_alarm(args: &[Value]) -> Result<Alarm, IpcError> {
    let object = args
        .first()
        .and_then(Value::as_object)
        .ok_or_else(|| invalid_argument("settings.upsertAlarm: alarm must be an object"))?;
    let field = |key: &str| object.get(key);
    Alarm::sanitized(
        field("id").and_then(Value::as_str).unwrap_or(""),
        field("label").and_then(Value::as_str).unwrap_or(""),
        field("fireAtMs")
            .and_then(Value::as_i64)
            .ok_or_else(|| invalid_argument("settings.upsertAlarm: fireAtMs must be an integer"))?,
        field("active").and_then(Value::as_bool).unwrap_or(true),
    )
    .ok_or_else(|| invalid_argument("settings.upsertAlarm: id must be 1 to 64 characters"))
}

fn write_failed(err: std::io::Error) -> IpcError {
    IpcError::new("settings-write-failed", err.to_string())
}

pub fn settings_upsert_alarm(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let alarm = parse_alarm(&args)?;
        let saved = state
            .settings
            .lock()
            .await
            .upsert_alarm(alarm)
            .await
            .map_err(write_failed)?;
        let Some(value) = saved else {
            return Err(IpcError::new(
                "alarm-limit",
                "Too many alarms; delete one first.",
            ));
        };
        wake_scheduler();
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}

pub fn settings_delete_alarm(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = arg_str(&args, 0)
            .ok_or_else(|| invalid_argument("settings.deleteAlarm: id must be a string"))?
            .trim()
            .to_string();
        if !Alarm::is_valid_id(&id) {
            return Err(invalid_argument(
                "settings.deleteAlarm: id must be 1 to 64 characters",
            ));
        }
        let value = state
            .settings
            .lock()
            .await
            .delete_alarm(&id)
            .await
            .map_err(write_failed)?;
        wake_scheduler();
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}
