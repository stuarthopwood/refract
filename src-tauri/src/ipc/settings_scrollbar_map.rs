// IPC handler for `settings.setShowScrollbarMap`. Own file to respect the 600-line cap (#806).
use serde_json::Value;

use super::settings::require_bool;
use super::{AppState, Dispatcher, HandlerFuture};

pub fn register(d: &mut Dispatcher) {
    d.register(
        "settings.setShowScrollbarMap",
        settings_set_show_scrollbar_map,
    );
}

pub fn settings_set_show_scrollbar_map(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let enabled = require_bool(&args, 0, "settings.setShowScrollbarMap", "enabled")?;
        let value = state
            .settings
            .lock()
            .await
            .set_show_scrollbar_map(enabled)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}
