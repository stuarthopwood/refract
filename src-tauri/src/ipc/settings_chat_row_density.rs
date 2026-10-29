// IPC handler for `settings.setChatRowDensity` (issue #1300). Its own file to keep `settings.rs`
// under the 600-line cap (issue #806).
use serde_json::Value;

use super::{invalid_argument, AppState, Dispatcher, HandlerFuture};
use crate::store::settings::ChatRowDensity;

pub fn register(d: &mut Dispatcher) {
    d.register("settings.setChatRowDensity", settings_set_chat_row_density);
}

pub fn settings_set_chat_row_density(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let value = args
            .first()
            .and_then(|v| v.as_str())
            .and_then(|v| ChatRowDensity::parse_str(v))
            .ok_or_else(|| {
                invalid_argument("settings.setChatRowDensity expects 'tight' | 'compact' | 'comfy'")
            })?;
        let value = state
            .settings
            .lock()
            .await
            .set_chat_row_density(value)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}
