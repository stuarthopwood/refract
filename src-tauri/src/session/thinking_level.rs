// Forwards OMP's `set_thinking_level` RPC. Never pins the Session or its role, since reasoning
// effort is orthogonal to model choice. Refuses while working (`request_rpc_if_idle`).

use serde_json::{json, Value};

use crate::omp::transcript::NoticeLevel;
use crate::store::registry::SessionPatch;

use super::agent::{AgentError, SessionAgent};
use super::model::model_support::post_notice;
use super::model::REQUEST_TIMEOUT_MS;

/// OMP's closed `ThinkingLevel` vocabulary; the only values `set_thinking_level` accepts.
const VALID_THINKING_LEVELS: [&str; 8] = [
    "inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max",
];

/// The UI's label for a level (mirrors `modelDisplay.ts`'s `THINKING_LEVEL_LABEL`).
fn reasoning_label(level: &str) -> String {
    match level {
        "inherit" => "Default".to_string(),
        "off" => "Off".to_string(),
        "minimal" => "Minimal".to_string(),
        "low" => "Low".to_string(),
        "medium" => "Medium".to_string(),
        "high" => "High".to_string(),
        "xhigh" => "Extra high".to_string(),
        "max" => "Max".to_string(),
        other => other.to_string(),
    }
}

pub(super) fn validate_level(level: &str) -> Result<(), AgentError> {
    if VALID_THINKING_LEVELS.contains(&level) {
        return Ok(());
    }
    Err(AgentError::new(
        "invalid-argument",
        format!(
            "Unknown reasoning level: {level}. Valid levels: {}",
            VALID_THINKING_LEVELS.join(", ")
        ),
    ))
}

pub async fn set_thinking_level(agent: &SessionAgent, level: &str) -> Result<Value, AgentError> {
    validate_level(level)?;
    let res = agent
        .request_rpc_if_idle(
            json!({ "type": "set_thinking_level", "level": level }),
            REQUEST_TIMEOUT_MS,
            "Switch the reasoning level",
        )
        .await?;
    if res.get("success").and_then(Value::as_bool) != Some(true) {
        let message = res
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Reasoning level not set.")
            .to_string();
        return Err(AgentError::new("prompt-failed", message));
    }
    let data = agent.refresh_from_state().await.map_err(|err| {
        AgentError::new(
            "prompt-failed",
            format!(
                "Reasoning level switched, but the new state could not be confirmed: {}",
                err.message
            ),
        )
    })?;
    let reported = data
        .get("thinkingLevel")
        .and_then(Value::as_str)
        .map(str::to_string);
    // `None` only for a non-`inherit` request the model didn't confirm.
    let wire_level = reported
        .clone()
        .or_else(|| (level == "inherit").then(|| "inherit".to_string()));
    // When OMP didn't echo the level, this is the only writer: `inherit` persists, any other
    // unconfirmed level clears a stale one. A reported level is stored by `sync_from_state`.
    if reported.is_none() {
        let stored_level = (level == "inherit").then(|| "inherit".to_string());
        let patched = agent
            .registry()
            .lock()
            .await
            .update_session(
                agent.session_id(),
                SessionPatch {
                    last_thinking_level: Some(stored_level),
                    ..Default::default()
                },
            )
            .await;
        if patched.is_ok() {
            agent.events().emit_session_list_changed();
        }
    }
    // The unconfirmed branch names the requested level, not the (absent) echoed one.
    let label = match &wire_level {
        Some(value) => reasoning_label(value),
        None => format!(
            "{} (not reported back by this model)",
            reasoning_label(level)
        ),
    };
    post_notice(
        agent,
        NoticeLevel::Info,
        format!("Reasoning switched to {label}."),
    )
    .await;
    Ok(json!({ "thinkingLevel": wire_level }))
}
