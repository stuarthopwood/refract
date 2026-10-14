// `conversations.startNew`/`.open` (agent-backed arms). See `mod.rs`'s own header for this
// module's place in the `agent/` split and the lane extension contract.

use serde_json::{json, Value};

use crate::omp::transcript::TranscriptState;
use crate::session::termination;
use crate::store::registry::SessionPatch;

use super::launch_support::{fetch_all_messages, verify_reattach};
use super::{AgentError, SessionAgent, SessionStatus, DEFAULT_REQUEST_TIMEOUT_MS};

impl SessionAgent {
    /// `conversations.startNew` (contracts/omp-usage.md "New Conversation"): same process, same
    /// worktree, a brand-new OMP session file. Only reachable while `idle` with a live process
    /// (a `stopped` Session instead goes through `start_with_conversation`).
    pub async fn start_new_conversation(&self) -> Result<(), AgentError> {
        let proc = {
            let mut state = self.state.lock().await;
            if state.status != SessionStatus::Idle || state.process.is_none() {
                return Err(AgentError::new(
                    "not-idle",
                    format!(
                        "SessionAgent {}: cannot start a new Conversation while {:?}",
                        self.session_id, state.status
                    ),
                ));
            }
            // Gate-fix (#856, round 2 MEDIUM): bumped here, BEFORE the `new_session` RPC/
            // registry clear below (not after, inside the transcript-reset block that used to
            // be this bump's only home) -- a settle-time reply still in flight from a turn that
            // just ended must already be stale (`sync_from_state`'s own `>= 2` rule) well before
            // this reset's own patch/registry write can land, not race it.
            state.turn_generation = state.turn_generation.wrapping_add(2);
            state.process.clone().unwrap()
        };
        // Lane R6 (issue #789), defense in depth: normally a no-op, since OMP's own
        // `RpcBtwController.close()` already cancels any running side question before
        // `new_session` itself runs. Best-effort: a failure here must never block starting the
        // new Conversation.
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
        }
        self.emit_patch_reset().await;
        // Lane R5 (issue #577, #712): clears the PREVIOUS Conversation's readout/subagent state
        // before (possibly) refreshing it from the brand-new one's `get_state` below -- never
        // left showing a stale reading if that request itself fails.
        crate::session::readout::on_conversation_reset(self).await;
        crate::session::subagents::on_conversation_reset(self).await;
        // Lane R6 (issue #789): a brand-new Conversation always means a brand-new side-chat
        // history store too -- unconditional, matching the readout/subagents resets above.
        crate::session::side_chat::on_conversation_reset(self).await;
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

    /// `conversations.open` (contracts/omp-usage.md "Open an earlier Conversation"): the same
    /// reattach verification `launch()` uses, reloading history AS-IS (never merged with the
    /// current live transcript -- this switches to a DIFFERENT Conversation). Simplified
    /// failure recovery (see this file's own header): a failed post-switch verification stops
    /// the process and marks the Session `stopped`/`start-failed`, rather than TS's own
    /// try-the-previous-Conversation-first recovery.
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
            // Gate-fix (#856, round 2 MEDIUM): see `start_new_conversation`'s own identical
            // comment -- bumped here, before `switch_session` below, not after.
            state.turn_generation = state.turn_generation.wrapping_add(2);
            state.process.clone().unwrap()
        };
        // Lane R6 (issue #789): captured BEFORE the switch below, so the side-chat conversation-
        // changed notification (below) can tell a genuine Conversation change from a reopen of
        // the SAME Conversation (whose side-chat topics are still valid, nothing to drop).
        let previous_conversation = self.current_conversation_path().await;
        // Lane R6 (issue #789), defense in depth: normally a no-op, since OMP's own
        // `RpcBtwController.close()` already cancels any running side question before
        // `switch_session` itself runs.
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
        // Issue #786 follow-up: `file` is the historical Conversation just switched to -- if
        // ITS tail shows it was abandoned mid tool-call, the row `settle_interrupted_tool_rows`
        // below settles to `interrupted` rather than leaving it `running` forever once rendered
        // as history. Port of `SessionAgent.ts`'s `openConversation` calling
        // `detectUnexpectedTermination(file)` at this exact point, read only when `complete`
        // (matching TS's own `if (complete) { ... }` gating).
        let terminated_unexpectedly = if complete {
            termination::detect_unexpected_termination_for_transcript(Some(&file)).await
        } else {
            false
        };
        {
            let mut state = self.state.lock().await;
            state.transcript = if complete {
                let mut fresh = TranscriptState::from_history(&messages);
                fresh.set_terminated_unexpectedly(terminated_unexpectedly);
                let _ = fresh.settle_interrupted_tool_rows();
                fresh
            } else {
                TranscriptState::new()
            };
        }
        // Lane R5 (issue #577, #712): this is a DIFFERENT Conversation's history, so the
        // previous one's readout/subagent state never carries over (see `start_new_conversation`
        // above for the identical reasoning).
        crate::session::readout::on_conversation_reset(self).await;
        crate::session::subagents::on_conversation_reset(self).await;
        // Lane R6 (issue #789): OMP's own `btw` topics are scoped to the OMP session FILE just
        // switched away from, so any side-chat topic/history the renderer still holds belongs to
        // `previous_conversation`, not `file` -- skipped when `file` IS `previous_conversation`
        // (reopening the same Conversation: its side-chat topics are still valid).
        if previous_conversation.as_deref() != Some(file.as_str()) {
            crate::session::side_chat::on_conversation_reset(self).await;
        }
        self.sync_from_state(&data, None).await;
        self.emit_patch_reset().await;
        Ok(())
    }
}
