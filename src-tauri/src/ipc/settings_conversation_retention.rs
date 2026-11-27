// IPC handler for `settings.setConversationRetention`. Own file to respect the 600-line cap (#806).
use serde_json::Value;

use super::{AppState, Dispatcher, HandlerFuture, IpcError};
use crate::store::settings::ConversationRetention;

pub fn register(d: &mut Dispatcher) {
    d.register(
        "settings.setConversationRetention",
        settings_set_conversation_retention,
    );
}

fn invalid(detail: &str) -> IpcError {
    IpcError::new(
        "invalid-argument",
        format!("settings.setConversationRetention expects {detail}"),
    )
}

fn parse_args(args: &[Value]) -> Result<ConversationRetention, IpcError> {
    let object = args
        .first()
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("an object argument"))?;
    let enabled = object
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| invalid("`enabled` to be a boolean"))?;
    let days = object
        .get("days")
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid("`days` to be a whole number"))?;
    Ok(ConversationRetention {
        enabled,
        days: u32::try_from(days).unwrap_or(u32::MAX),
    })
}

pub fn settings_set_conversation_retention(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let retention = parse_args(&args)?;
        let value = state
            .settings
            .lock()
            .await
            .set_conversation_retention(retention)
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
    fn a_well_formed_object_parses() {
        let parsed = parse_args(&[json!({ "enabled": true, "days": 30 })]).unwrap();
        assert_eq!(
            parsed,
            ConversationRetention {
                enabled: true,
                days: 30
            }
        );
    }

    #[test]
    fn anything_else_is_rejected() {
        for bad in [
            json!(null),
            json!("on"),
            json!({ "enabled": "yes", "days": 30 }),
            json!({ "enabled": true }),
            json!({ "enabled": true, "days": -3 }),
            json!({ "enabled": true, "days": "30" }),
        ] {
            let err = parse_args(std::slice::from_ref(&bad)).unwrap_err();
            assert_eq!(err.code, "invalid-argument", "{bad}");
        }
        assert!(parse_args(&[]).is_err());
    }
}
