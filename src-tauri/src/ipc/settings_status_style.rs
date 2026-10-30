// IPC handler for `settings.setStatusStyle`. Own file to respect the 600-line cap (#806).
use serde_json::Value;

use super::{invalid_argument, AppState, Dispatcher, HandlerFuture};
use crate::store::settings::StatusStyle;

pub fn register(d: &mut Dispatcher) {
    d.register("settings.setStatusStyle", settings_set_status_style);
}

pub fn settings_set_status_style(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let value = args
            .first()
            .and_then(|v| v.as_str())
            .and_then(|v| serde_json::from_value::<StatusStyle>(Value::String(v.to_string())).ok())
            .ok_or_else(|| invalid_argument("settings.setStatusStyle expects 'icons' | 'dots'"))?;
        let value = state
            .settings
            .lock()
            .await
            .set_status_style(value)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}
