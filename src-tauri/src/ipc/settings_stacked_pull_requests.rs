// IPC handler for `settings.setStackedPullRequests` (#1867). Own file to respect the 600-line cap (#806).
use serde_json::Value;

use super::settings::require_bool;
use super::{AppState, Dispatcher, HandlerFuture, IpcError};

const CHANNEL: &str = "settings.setStackedPullRequests";

pub fn register(d: &mut Dispatcher) {
    d.register(CHANNEL, settings_set_stacked_pull_requests);
}

/// A non-boolean argument is an invalid-argument error, never coerced.
fn enabled_arg(args: &[Value]) -> Result<bool, IpcError> {
    require_bool(args, 0, CHANNEL, "enabled")
}

pub fn settings_set_stacked_pull_requests(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let enabled = enabled_arg(&args)?;
        let value = state
            .settings
            .lock()
            .await
            .set_stacked_pull_requests(enabled)
            .await
            .map_err(|err| IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_a_boolean() {
        assert!(enabled_arg(&[json!(true)]).unwrap());
        assert!(!enabled_arg(&[json!(false)]).unwrap());
    }

    #[test]
    fn rejects_non_booleans_and_a_missing_argument() {
        for bad in [json!("true"), json!(1), json!(null), json!({})] {
            assert!(enabled_arg(&[bad]).is_err());
        }
        assert!(enabled_arg(&[]).is_err());
    }
}
