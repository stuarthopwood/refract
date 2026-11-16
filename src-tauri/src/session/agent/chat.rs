// Prompt, stop and remove-queued commands for a session agent.

use serde_json::{json, Value};

use super::chat_restore::{empty_restored_queue, parse_restored_queue};
use super::{
    AgentError, SessionAgent, SessionStatus, ABORT_SETTLE_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS,
};

/// How a Session message reached its target (#1858).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageDelivery {
    Sent,
    Queued,
    Held,
}

/// Paused wins over busy; a busy target queues; an idle one takes the message at once.
fn delivery_of(held: bool, response: &Value) -> MessageDelivery {
    if held {
        MessageDelivery::Held
    } else if response.get("queued").and_then(Value::as_bool) == Some(true) {
        MessageDelivery::Queued
    } else {
        MessageDelivery::Sent
    }
}

/// Only an idle prompt that is not a drain follow-up gets the working-mode wrapper, and Session
/// messages opt out so the envelope reaches the target verbatim.
fn should_decorate(working: bool, force_follow_up: bool, decorate: bool) -> bool {
    decorate && !working && !force_follow_up
}

impl SessionAgent {
    /// Sends a prompt, or holds it while the session is paused.
    /// OMP expects `message`, not `text`.
    pub async fn send(
        &self,
        text: String,
        images: Option<Vec<Value>>,
    ) -> Result<Value, AgentError> {
        if let Some(held) = self.hold_if_paused(&text, &images).await? {
            return Ok(held);
        }
        self.send_unheld(text, images, false).await
    }

    /// Delivers another Session's envelope (#1858): held while paused, queued while busy, never
    /// decorated, since the envelope text must reach the target verbatim.
    pub async fn send_session_message(&self, text: String) -> Result<MessageDelivery, AgentError> {
        if self.hold_if_paused(&text, &None).await?.is_some() {
            return Ok(delivery_of(true, &Value::Null));
        }
        let res = self.send_unheld_with(text, None, false, false).await?;
        Ok(delivery_of(false, &res))
    }

    /// Sends without the pause gate, so `resume` can drain held messages.
    /// `force_follow_up` avoids racing the status update of the first message in a drain.
    pub(super) async fn send_unheld(
        &self,
        text: String,
        images: Option<Vec<Value>>,
        force_follow_up: bool,
    ) -> Result<Value, AgentError> {
        self.send_unheld_with(text, images, force_follow_up, true)
            .await
    }

    /// `decorate` adds the working-mode wrapper to an idle send; Session messages pass `false`.
    async fn send_unheld_with(
        &self,
        text: String,
        images: Option<Vec<Value>>,
        force_follow_up: bool,
        decorate: bool,
    ) -> Result<Value, AgentError> {
        crate::session::token_guard::await_shake(self).await;
        let (proc, working) = {
            let idle_with_process = {
                let state = self.state.lock().await;
                state.status == SessionStatus::Idle && state.process.is_some()
            };
            // A queued role, model or reasoning choice applies before the next prompt.
            if idle_with_process {
                crate::session::pending_selection::drain(self).await;
            }
            let mut state = self.state.lock().await;
            // Marks the user as having acted first, so startup notices stay visible.
            state.transcript.mark_user_acted();
            let proc = state.process.clone().ok_or_else(|| {
                AgentError::new(
                    "agent-not-running",
                    format!(
                        "SessionAgent {}: cannot send, no live process",
                        self.session_id
                    ),
                )
            })?;
            let working = matches!(
                state.status,
                SessionStatus::Working | SessionStatus::NeedsYou
            );
            (proc, working)
        };
        let text = if should_decorate(working, force_follow_up, decorate) {
            crate::session::working_mode::decorate_prompt(self, text).await
        } else {
            text
        };
        let mut cmd = json!({ "type": "prompt", "message": text });
        if let Some(images) = images {
            if !images.is_empty() {
                cmd["images"] = Value::Array(images);
            }
        }
        if working || force_follow_up {
            cmd["streamingBehavior"] = Value::String("followUp".to_string());
        }
        let res = proc
            .request(cmd, DEFAULT_REQUEST_TIMEOUT_MS)
            .await
            .map_err(|err| AgentError::new("prompt-failed", err.to_string()))?;
        if res.get("success").and_then(Value::as_bool) != Some(true) {
            let err_message = res
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
                .to_string();
            let detail = format!("prompt failed: {err_message}");
            self.append_notice(detail.clone(), "error").await;
            return Err(AgentError::new("prompt-failed", detail));
        }
        Ok(json!({ "queued": working }))
    }

    /// Aborts the turn and returns withdrawn queued messages.
    /// Waits for the turn to settle. A no-op while idle or with no live process.
    pub async fn stop(&self) -> Result<Value, AgentError> {
        let (proc, status) = {
            let mut state = self.state.lock().await;
            let proc = state.process.clone();
            let status = state.status;
            // Set only mid-turn, before the abort RPC, so a late tool event cannot race the flag.
            let turn_in_flight = matches!(status, SessionStatus::Working | SessionStatus::NeedsYou)
                && state.turn_generation % 2 == 1;
            if proc.is_some() && turn_in_flight {
                state.turn_abort_requested = true;
            }
            (proc, status)
        };
        let Some(proc) = proc else {
            return Ok(empty_restored_queue());
        };
        if status == SessionStatus::Idle {
            return Ok(empty_restored_queue());
        }
        // Older runtimes reject this command, so fall back to a plain `abort`.
        let mut restored = empty_restored_queue();
        let abort_result = match proc
            .request(
                json!({ "type": "abort_and_restore_queue" }),
                DEFAULT_REQUEST_TIMEOUT_MS,
            )
            .await
        {
            Ok(res) if res.get("success").and_then(Value::as_bool) == Some(true) => {
                restored = parse_restored_queue(res.get("data").unwrap_or(&Value::Null));
                Ok(res)
            }
            // Any rejection falls back to plain `abort`, so the turn still stops.
            Ok(_) => {
                proc.request(json!({ "type": "abort" }), DEFAULT_REQUEST_TIMEOUT_MS)
                    .await
            }
            Err(err) => Err(err),
        };
        match abort_result {
            Ok(res) if res.get("success").and_then(Value::as_bool) == Some(true) => {}
            Ok(res) => {
                // The abort did not take effect, so clear the flag.
                self.state.lock().await.turn_abort_requested = false;
                let err_message = res
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown error")
                    .to_string();
                self.append_notice(format!("abort failed: {err_message}"), "error")
                    .await;
            }
            Err(_) => {
                // Timeout or transport error: clear the flag, as above.
                self.state.lock().await.turn_abort_requested = false;
            }
        }
        let mut rx = self.status_tx.subscribe();
        if matches!(*rx.borrow(), SessionStatus::Idle | SessionStatus::Stopped) {
            return Ok(restored);
        }
        let wait = async {
            while rx.changed().await.is_ok() {
                if matches!(*rx.borrow(), SessionStatus::Idle | SessionStatus::Stopped) {
                    return;
                }
            }
        };
        if tokio::time::timeout(
            std::time::Duration::from_millis(ABORT_SETTLE_TIMEOUT_MS),
            wait,
        )
        .await
        .is_err()
        {
            // The queue is already withdrawn, so return it rather than the error.
            let has_restored = restored["messages"]
                .as_array()
                .is_some_and(|messages| !messages.is_empty());
            if has_restored {
                self.append_notice(
                    "Stop is taking longer than expected; your queued messages were returned."
                        .to_string(),
                    "info",
                )
                .await;
                return Ok(restored);
            }
            return Err(AgentError::new(
                "prompt-failed",
                format!(
                    "SessionAgent {}: timed out waiting for idle",
                    self.session_id
                ),
            ));
        }
        Ok(restored)
    }

    /// Shared request for queue commands. Returns the response's `data` on success.
    /// A failed response is posted as a transcript notice and returned as an error.
    pub(super) async fn queue_op(
        &self,
        cmd: Value,
        action: &str,
        no_process_detail: &str,
    ) -> Result<Value, AgentError> {
        let proc = {
            self.state.lock().await.process.clone().ok_or_else(|| {
                AgentError::new(
                    "agent-not-running",
                    format!("SessionAgent {}: {no_process_detail}", self.session_id),
                )
            })?
        };
        let res = proc
            .request(cmd, DEFAULT_REQUEST_TIMEOUT_MS)
            .await
            .map_err(|err| AgentError::new("prompt-failed", err.to_string()))?;
        if res.get("success").and_then(Value::as_bool) != Some(true) {
            let err_message = res
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
                .to_string();
            let detail = format!("{action} failed: {err_message}");
            self.append_notice(detail.clone(), "error").await;
            return Err(AgentError::new("prompt-failed", detail));
        }
        Ok(res.get("data").cloned().unwrap_or(Value::Null))
    }

    /// Removes a queued message. OMP only matches within the queue named by `queue`.
    pub async fn remove_queued(&self, text: String, queue: &str) -> Result<Value, AgentError> {
        if self.remove_held(&text).await {
            return Ok(json!({ "removed": true }));
        }
        let data = self
            .queue_op(
                json!({ "type": "remove_queued_message", "message": text, "queue": queue }),
                "remove_queued_message",
                "cannot remove a queued message, no live process",
            )
            .await?;
        let removed = data
            .get("removed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok(json!({ "removed": removed }))
    }

    /// Promotes a queued follow-up to steering in one atomic call, so it cannot be lost.
    /// `promoted: false` means it was already delivered.
    pub async fn send_now(&self, text: String) -> Result<Value, AgentError> {
        let data = self
            .queue_op(
                json!({ "type": "promote_queued_message", "message": text }),
                "promote_queued_message",
                "cannot send now, no live process",
            )
            .await?;
        let promoted = data
            .get("promoted")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok(json!({ "promoted": promoted }))
    }
}

#[cfg(test)]
#[path = "chat.test.rs"]
mod tests;
