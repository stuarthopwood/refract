// Agent-backed `conversations.startNew` and `conversations.open` arms.

use serde_json::{json, Value};

use crate::omp::transcript::TranscriptState;
use crate::session::termination;
use crate::store::registry::SessionPatch;

use super::launch_support::{fetch_all_messages, verify_reattach};
use super::{AgentError, SessionAgent, SessionStatus, DEFAULT_REQUEST_TIMEOUT_MS};

/// A never-started Session has no Conversation to reset, so `/new` is a no-op there (#1812).
/// A stopped Session that once ran carries another stop reason and keeps the `not-idle` refusal.
fn new_conversation_is_noop(
    status: SessionStatus,
    has_process: bool,
    stop_reason: Option<&str>,
) -> bool {
    status == SessionStatus::Stopped
        && !has_process
        && matches!(stop_reason, None | Some("not-started"))
}

impl SessionAgent {
    /// Starts a fresh OMP session file in the same process and worktree.
    /// Only reachable while `idle` with a live process.
    pub async fn start_new_conversation(&self) -> Result<(), AgentError> {
        let proc = {
            let mut state = self.state.lock().await;
            if new_conversation_is_noop(state.status, state.process.is_some(), state.stop_reason) {
                return Ok(());
            }
            if state.status != SessionStatus::Idle || state.process.is_none() {
                return Err(AgentError::new(
                    "not-idle",
                    format!(
                        "SessionAgent {}: cannot start a new Conversation while {:?}",
                        self.session_id, state.status
                    ),
                ));
            }
            // Bump before the reset so a late settle-time reply is already stale (#856).
            state.turn_generation = state.turn_generation.wrapping_add(2);
            state.process.clone().unwrap()
        };
        // Best-effort: a failed side-chat cancel must not block the new Conversation (#789).
        let _ = crate::session::side_chat::cancel(self).await;
        let res = proc
            .request(json!({ "type": "new_session" }), DEFAULT_REQUEST_TIMEOUT_MS)
            .await
            .map_err(|err| AgentError::new("prompt-failed", err.to_string()))?;
        if res.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(AgentError::new(
                "prompt-failed",
                format!(
                    "new_session failed: {}",
                    res.get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown error")
                ),
            ));
        }
        let patch = SessionPatch {
            current_conversation: Some(None),
            last_message_count: Some(None),
            ..Default::default()
        };
        let _ = self
            .registry
            .lock()
            .await
            .update_session(&self.session_id, patch)
            .await;
        {
            let mut state = self.state.lock().await;
            state.transcript = TranscriptState::new();
            state.pause.cancelled.clear();
        }
        self.emit_patch_reset().await;
        // Clear the old readout first so a failed `get_state` never shows stale data (#577).
        crate::session::readout::on_conversation_reset(self).await;
        crate::session::subagents::on_conversation_reset(self).await;
        // A new Conversation always gets a fresh side-chat history (#789).
        crate::session::side_chat::on_conversation_reset(self).await;
        crate::session::token_guard::on_conversation_reset(self, None).await;
        if let Ok(res) = proc
            .request(json!({ "type": "get_state" }), DEFAULT_REQUEST_TIMEOUT_MS)
            .await
        {
            if res.get("success").and_then(Value::as_bool) == Some(true) {
                if let Some(data) = res.get("data") {
                    self.sync_from_state(data, None).await;
                }
            }
        }
        Ok(())
    }

    /// Switches to an earlier Conversation and reloads its history as-is.
    /// A failed post-switch verification stops the process and marks the Session `start-failed`.
    pub async fn open_conversation(&self, file: String) -> Result<(), AgentError> {
        let proc = {
            let mut state = self.state.lock().await;
            if state.status != SessionStatus::Idle || state.process.is_none() {
                return Err(AgentError::new(
                    "not-idle",
                    format!(
                        "SessionAgent {}: cannot open a Conversation while {:?}",
                        self.session_id, state.status
                    ),
                ));
            }
            // Bump before the switch so a late settle-time reply is already stale (#856).
            state.turn_generation = state.turn_generation.wrapping_add(2);
            state.process.clone().unwrap()
        };
        // Captured before the switch, so a reopen of the same Conversation keeps its side-chat topics (#789).
        let previous_conversation = self.current_conversation_path().await;
        // Best-effort side-chat cancel before the switch (#789).
        let _ = crate::session::side_chat::cancel(self).await;
        let switch_res = proc
            .request(
                json!({ "type": "switch_session", "sessionPath": file }),
                DEFAULT_REQUEST_TIMEOUT_MS,
            )
            .await
            .map_err(|err| AgentError::new("reattach-failed", err.to_string()))?;
        let cancelled = switch_res
            .get("data")
            .and_then(|d| d.get("cancelled"))
            .and_then(Value::as_bool);
        if switch_res.get("success").and_then(Value::as_bool) != Some(true)
            || cancelled != Some(false)
        {
            return Err(AgentError::new(
                "reattach-failed",
                format!("switch_session failed or was cancelled for {file}"),
            ));
        }

        let state_res = match proc
            .request(json!({ "type": "get_state" }), DEFAULT_REQUEST_TIMEOUT_MS)
            .await
        {
            Ok(res) => res,
            Err(err) => {
                proc.stop().await;
                self.state.lock().await.process = None;
                let detail = err.to_string();
                self.record_start_failure(&detail).await;
                return Err(AgentError::new("reattach-failed", detail));
            }
        };
        if state_res.get("success").and_then(Value::as_bool) != Some(true) {
            proc.stop().await;
            self.state.lock().await.process = None;
            let detail = format!(
                "get_state after switch_session failed: {}",
                state_res
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown error")
            );
            self.record_start_failure(&detail).await;
            return Err(AgentError::new("reattach-failed", detail));
        }
        let data = state_res.get("data").cloned().unwrap_or(Value::Null);
        if let Err(failure) = verify_reattach(&file, &data) {
            proc.stop().await;
            self.state.lock().await.process = None;
            self.record_start_failure(&failure).await;
            return Err(AgentError::new("reattach-failed", failure));
        }

        let (messages, complete) = fetch_all_messages(&proc).await;
        // Settle rows the old tail left `running`, so history never shows them forever (#786).
        let terminated_unexpectedly = if complete {
            termination::detect_unexpected_termination_for_transcript(Some(&file)).await
        } else {
            false
        };
        {
            let mut state = self.state.lock().await;
            state.pause.cancelled.clear();
            state.transcript = if complete {
                let mut fresh = TranscriptState::from_history(&messages);
                fresh.set_terminated_unexpectedly(terminated_unexpectedly);
                let _ = fresh.settle_interrupted_tool_rows();
                fresh
            } else {
                TranscriptState::new()
            };
        }
        // A different Conversation, so the old readout and subagent state must not carry over (#577).
        crate::session::readout::on_conversation_reset(self).await;
        if complete {
            crate::session::readout::on_history_loaded(self, &messages).await;
        }
        crate::session::subagents::on_conversation_reset(self).await;
        // Side-chat topics belong to the file switched away from, so drop them unless reopening it (#789).
        if previous_conversation.as_deref() != Some(file.as_str()) {
            crate::session::side_chat::on_conversation_reset(self).await;
        }
        crate::session::token_guard::on_conversation_reset(self, complete.then_some(&messages[..]))
            .await;
        self.sync_from_state(&data, None).await;
        self.emit_patch_reset().await;
        Ok(())
    }
}

#[cfg(test)]
#[path = "conversations.test.rs"]
mod tests;
