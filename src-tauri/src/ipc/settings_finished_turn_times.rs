// IPC handler for `settings.setShowFinishedTurnTimes` (issue #1250, spec 001 FR-119). Its own file
// (not inline in `settings.rs`) to keep that file under this build's 600-line cap (issue #806).
use serde_json::Value;

use super::settings::require_bool;
use super::{AppState, Dispatcher, HandlerFuture};

pub fn register(d: &mut Dispatcher) {
    d.register(
        "settings.setShowFinishedTurnTimes",
        settings_set_show_finished_turn_times,
    );
}

pub fn settings_set_show_finished_turn_times(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let enabled = require_bool(&args, 0, "settings.setShowFinishedTurnTimes", "enabled")?;
        let value = state
            .settings
            .lock()
            .await
            .set_show_finished_turn_times(enabled)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}
