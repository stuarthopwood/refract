// IPC handlers for `settings.setSessionNotificationSounds` and `settings.setAlarmSounds` (#1666).
use serde_json::Value;

use super::settings::require_bool;
use super::{AppState, Dispatcher, HandlerFuture};

pub fn register(d: &mut Dispatcher) {
    d.register(
        "settings.setSessionNotificationSounds",
        settings_set_session_notification_sounds,
    );
    d.register("settings.setAlarmSounds", settings_set_alarm_sounds);
}

pub fn settings_set_session_notification_sounds(
    state: AppState,
    args: Vec<Value>,
) -> HandlerFuture {
    Box::pin(async move {
        let enabled = require_bool(
            &args,
            0,
            "settings.setSessionNotificationSounds",
            "enabled",
        )?;
        let value = state
            .settings
            .lock()
            .await
            .set_session_notification_sounds(enabled)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}

pub fn settings_set_alarm_sounds(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let enabled = require_bool(&args, 0, "settings.setAlarmSounds", "enabled")?;
        let value = state
            .settings
            .lock()
            .await
            .set_alarm_sounds(enabled)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}
