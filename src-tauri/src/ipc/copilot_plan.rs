// Never returns a token; the network call and its caching live in `github::copilot_plan`.

use serde_json::{json, Value};

use super::{AppState, Dispatcher, HandlerFuture};

pub fn register(d: &mut Dispatcher) {
    d.register("copilot.planUsage", copilot_plan_usage);
    d.register("settings.setShowAiCredits", settings_set_show_ai_credits);
}

/// Lives here because `settings.rs` is at the file-size cap.
fn settings_set_show_ai_credits(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let enabled =
            super::settings::require_bool(&args, 0, "settings.setShowAiCredits", "enabled")?;
        let value = state
            .settings
            .lock()
            .await
            .set_show_ai_credits(enabled)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}

fn copilot_plan_usage(_state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        Ok(
            match crate::github::copilot_plan::plan_percent_used().await {
                Some(percent) => json!({ "percentUsed": percent }),
                None => Value::Null,
            },
        )
    })
}
