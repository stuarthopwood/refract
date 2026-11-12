// `refract_send_session_message` (#1858): the checks run in the contract's order, then the text
// goes to the target wrapped in an envelope. A stopped Session is refused and never started.

use std::cell::Cell;
use std::time::Instant;

use serde_json::{json, Value};

use super::envelope;
use super::router::{ToolError, INVALID_INPUT};
use super::sessions::{check_args, status_of, NOT_FOUND, SEND_SESSION_MESSAGE};
use super::sessions_limit::{SendLimiter, LIMITER};
use crate::session::agent::{AgentError, MessageDelivery, SessionAgent};

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
    // A stopped Session that kept its pause reads as `paused` but has no process to deliver to.
    let stopped = status == "stopped" || target["status"].as_str() == Some("stopped");
    if stopped || archived {
        let shown = if archived { "archived" } else { "stopped" };
        return Err(ToolError::new(
            SESSION_NOT_RUNNING,
            format!("the target Session is {shown}; Session messages never start a Session"),
        ));
    }
    Ok(target)
}

/// A send that passed every check and holds one rate-limit slot until `settle` resolves it; a plan
/// dropped unsettled (the tool call was cancelled mid-send) gives the slot back.
#[derive(Debug)]
pub struct SendPlan<'a> {
    pub from: &'a str,
    pub id: &'a str,
    pub text: &'a str,
    pub sender: &'a str,
    slot: Instant,
    limiter: &'a SendLimiter,
    holds_slot: Cell<bool>,
}

impl SendPlan<'_> {
    fn release_slot(&self) {
        if self.holds_slot.replace(false) {
            self.limiter.release(self.from, self.id, self.slot);
        }
    }
}

impl Drop for SendPlan<'_> {
    fn drop(&mut self) {
        self.release_slot();
    }
}

/// Runs the contract's checks in order: arguments, existence, self, running, then the rate limit.
/// The limit is checked and counted together, so two concurrent sends cannot both take the last slot.
pub fn plan_send<'a>(
    args: &'a Value,
    summaries: &'a [Value],
    self_id: &'a str,
    limiter: &'a SendLimiter,
    now: Instant,
) -> Result<SendPlan<'a>, ToolError> {
    let (id, text) = parse_args(args)?;
    check_target(summaries, self_id, id)?;
    limiter.try_acquire(self_id, id, now).map_err(|wait| {
        ToolError::new(
            RATE_LIMITED,
            format!("too many messages to this Session; try again in {wait} seconds"),
        )
    })?;
    let sender = summaries
        .iter()
        .find(|s| s["id"].as_str() == Some(self_id))
        .and_then(|s| s["name"].as_str())
        .unwrap_or(self_id);
    Ok(SendPlan {
        from: self_id,
        id,
        text,
        sender,
        slot: now,
        limiter,
        holds_slot: Cell::new(true),
    })
}

/// The tool result for a delivery attempt; a failed one gives its rate-limit slot back.
pub fn settle(
    plan: &SendPlan<'_>,
    delivery: Result<MessageDelivery, AgentError>,
) -> Result<Value, ToolError> {
    match delivery {
        Ok(delivery) => {
            plan.holds_slot.set(false);
            Ok(json!({ "outcome": outcome_name(delivery) }))
        }
        Err(err) => {
            plan.release_slot();
            Err(match err.code {
                "agent-not-running" => ToolError::new(
                    SESSION_NOT_RUNNING,
                    "the target Session stopped before the message was sent",
                ),
                _ => ToolError::new(err.code, err.message),
            })
        }
    }
}

pub async fn send(agent: &SessionAgent, args: &Value) -> Result<Value, ToolError> {
    let manager = agent.tool_manager().ok_or_else(|| {
        ToolError::new(
            super::router::CANCELLED,
            "Refract is shutting down; no Session can be reached",
        )
    })?;
    let self_id = agent.tool_session_id();
    let summaries = manager.summaries().await;
    let plan = plan_send(args, &summaries, self_id, &LIMITER, Instant::now())?;
    let delivery = match manager.get_agent(plan.id) {
        Some(target) => {
            target
                .send_session_message(envelope::wrap(plan.sender, plan.from, plan.text))
                .await
        }
        None => Err(AgentError::new(
            "agent-not-running",
            "the target Session has no live agent",
        )),
    };
    settle(&plan, delivery)
}

#[cfg(test)]
#[path = "sessions_send.test.rs"]
mod tests;
