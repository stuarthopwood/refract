// IPC handler for `settings.setTypography` (spec 035 WP-E). Its own file to keep `settings.rs`
// under the 600-line cap (issue #806).
use serde_json::Value;

use super::{AppState, Dispatcher, HandlerFuture, IpcError};
use crate::store::settings::Typography;

pub fn register(d: &mut Dispatcher) {
    d.register("settings.setTypography", settings_set_typography);
}

fn scale_field(object: &serde_json::Map<String, Value>, name: &str) -> Result<f64, IpcError> {
    object
        .get(name)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .ok_or_else(|| {
            IpcError::new(
                "invalid-argument",
                format!("settings.setTypography expects `{name}` to be a finite number"),
            )
        })
}

pub fn settings_set_typography(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let object = args.first().and_then(Value::as_object).ok_or_else(|| {
            IpcError::new(
                "invalid-argument",
                "settings.setTypography expects an object argument",
            )
        })?;
        let typography = Typography {
            app_scale: scale_field(object, "appScale")?,
            chat_scale: scale_field(object, "chatScale")?,
            code_scale: scale_field(object, "codeScale")?,
        };
        let value = state
            .settings
            .lock()
            .await
            .set_typography(typography)
            .await
            .map_err(|err| IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}
