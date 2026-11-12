// `refract_send_session_message` (#1858): the checks run in the contract's order, then the text
// goes to the target wrapped in an envelope. A stopped Session is refused and never started.

use std::time::Instant;

use serde_json::{json, Value};

use super::envelope;
use super::router::{ToolError, INVALID_INPUT};
use super::sessions::{check_args, status_of, NOT_FOUND, SEND_SESSION_MESSAGE};
use super::sessions_limit::{SendLimiter, LIMITER};
use crate::session::agent::{MessageDelivery, SessionAgent};

pub const INVALID_TARGET: &str = "invalid_target";
pub const SESSION_NOT_RUNNING: &str = "session_not_running";
pub const RATE_LIMITED: &str = "rate_limited";
pub const MAX_TEXT_BYTES: usize = 32 * 1024;

pub fn outcome_name(delivery: MessageDelivery) -> &'static str {
    match delivery {
        MessageDelivery::Sent => "sent",
        MessageDelivery::Queued => "queued",
        MessageDelivery::Held => "held",
    }
}

/// `(id, text)` once the arguments are well formed.
pub fn parse_args(args: &Value) -> Result<(&str, &str), ToolError> {
    check_args(SEND_SESSION_MESSAGE, args)?;
    let id = args["id"].as_str().unwrap_or_default();
    let text = args["text"].as_str().unwrap_or_default();
    if id.is_empty() {
        return Err(ToolError::new(INVALID_INPUT, "id must not be empty"));
    }
    if text.trim().is_empty() {
        return Err(ToolError::new(INVALID_INPUT, "text must not be empty"));
    }
    if text.len() > MAX_TEXT_BYTES {
        return Err(ToolError::new(
            INVALID_INPUT,
            format!(
                "text is {} bytes; the limit is {MAX_TEXT_BYTES}",
                text.len()
            ),
        ));
    }
    Ok((id, text))
}

/// The target's row after the existence, self and running checks, in that order.
pub fn check_target<'a>(
    summaries: &'a [Value],
    self_id: &str,
    id: &str,
) -> Result<&'a Value, ToolError> {
    let target = summaries
        .iter()
        .find(|s| s["id"].as_str() == Some(id))
        .ok_or_else(|| ToolError::new(NOT_FOUND, format!("no Session has id {id}")))?;
    if id == self_id {
        return Err(ToolError::new(
            INVALID_TARGET,
            "a Session cannot message itself",
        ));
    }
    let (status, _) = status_of(target);
    let archived = target["archivedAt"].is_string();
    if target["status"].as_str() == Some("stopped") || archived {
        let shown = if archived { "archived" } else { status };
        return Err(ToolError::new(
            SESSION_NOT_RUNNING,
            format!("the target Session is {shown}; Session messages never start a Session"),
        ));
    }
    Ok(target)
}

/// Refuses an eleventh delivered send to one target within the window.
pub fn check_rate(
    limiter: &SendLimiter,
    from: &str,
    to: &str,
    now: Instant,
) -> Result<(), ToolError> {
    limiter.check(from, to, now).map_err(|wait| {
        ToolError::new(
            RATE_LIMITED,
            format!("too many messages to this Session; try again in {wait} seconds"),
        )
    })
}

pub async fn send(agent: &SessionAgent, args: &Value) -> Result<Value, ToolError> {
    let (id, text) = parse_args(args)?;
    let manager = agent.tool_manager().ok_or_else(|| {
        ToolError::new(
            super::router::CANCELLED,
            "Refract is shutting down; no Session can be reached",
        )
    })?;
    let self_id = agent.tool_session_id();
    let summaries = manager.summaries().await;
    check_target(&summaries, self_id, id)?;
    check_rate(&LIMITER, self_id, id, Instant::now())?;
    let sender = summaries
        .iter()
        .find(|s| s["id"].as_str() == Some(self_id))
        .and_then(|s| s["name"].as_str())
        .unwrap_or(self_id);
    let target = manager.get_agent(id).ok_or_else(|| {
        ToolError::new(SESSION_NOT_RUNNING, "the target Session has no live agent")
    })?;
    let delivery = target
        .send_session_message(envelope::wrap(sender, self_id, text))
        .await
        .map_err(|e| match e.code {
            "agent-not-running" => ToolError::new(
                SESSION_NOT_RUNNING,
                "the target Session stopped before the message was sent",
            ),
            _ => ToolError::new(e.code, e.message),
        })?;
    LIMITER.record(self_id, id, Instant::now());
    Ok(json!({ "outcome": outcome_name(delivery) }))
}

#[cfg(test)]
#[path = "sessions_send.test.rs"]
mod tests;
