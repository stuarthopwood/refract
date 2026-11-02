// Prewalk state for the Session menu. omp exposes no prewalk state field, so only its own
// `/prewalk` replies and `source: prewalk` notices count; anything else leaves the claim unknown (#695).

use serde_json::Value;

use super::agent::SessionAgent;

/// `armed`, `off` or `unknown` for one frame, or `None` when the frame says nothing about prewalk.
fn state_from_frame(frame_type: &str, frame: &Value) -> Option<&'static str> {
    match frame_type {
        "command_output" => {
            let text = frame
                .get("text")
                .and_then(Value::as_str)
                .or_else(|| frame.get("message").and_then(Value::as_str))?
                .trim();
            if text.starts_with("Prewalk on:") {
                Some("armed")
            } else if text.starts_with("Prewalk off:") || text.starts_with("Prewalk already off") {
                Some("off")
            } else {
                None
            }
        }
        "notice" if frame.get("source").and_then(Value::as_str) == Some("prewalk") => {
            let message = frame.get("message").and_then(Value::as_str)?;
            if message.contains("disarmed") {
                Some("off")
            } else if message.starts_with("Prewalk: armed") || message.starts_with("Prewalk: already armed") {
                Some("armed")
            } else {
                // A handoff or any wording we have not verified: stop claiming "armed".
                Some("unknown")
            }
        }
        _ => None,
    }
}

pub(super) async fn on_frame(agent: &SessionAgent, frame_type: &str, frame: &Value) {
    if let Some(state) = state_from_frame(frame_type, frame) {
        agent.events().emit_prewalk_update(agent.session_id(), state);
    }
}

/// A fresh omp process has reported nothing yet.
pub(super) async fn on_launch(agent: &SessionAgent) {
    agent.events().emit_prewalk_update(agent.session_id(), "unknown");
}
