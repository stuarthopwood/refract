// IPC handler for `settings.setCodeLigatures`. Own file to respect the 600-line cap (#806).
use serde_json::Value;

use super::settings::require_bool;
use super::{AppState, Dispatcher, HandlerFuture};

pub fn register(d: &mut Dispatcher) {
    d.register("settings.setCodeLigatures", settings_set_code_ligatures);
}

pub fn settings_set_code_ligatures(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let enabled = require_bool(&args, 0, "settings.setCodeLigatures", "enabled")?;
        let value = state
            .settings
            .lock()
            .await
            .set_code_ligatures(enabled)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}
