// Lane-extension RPC and role-reapply helpers, split out of `mod.rs` to stay under the line cap.

use serde_json::{json, Value};

use super::{AgentError, SessionAgent, SessionStatus, DEFAULT_REQUEST_TIMEOUT_MS};

impl SessionAgent {
    /// Generic RPC passthrough for a lane module. No idle check; use `request_rpc_if_idle`.
    pub(in crate::session) async fn request_rpc(
        &self,
        cmd: Value,
        timeout_ms: u64,
    ) -> Result<Value, AgentError> {
        let proc = {
            let state = self.state.lock().await;
            state.process.clone().ok_or_else(|| {
                AgentError::new(
                    "agent-not-running",
                    format!(
                        "SessionAgent {}: cannot send, no live process",
                        self.session_id
                    ),
                )
            })?
        };
        proc.request(cmd, timeout_ms)
            .await
            .map_err(|err| AgentError::new("prompt-failed", err.to_string()))
    }

    /// Checks idle and takes the process handle under one lock, so no turn can start between them.
    /// Refuses with `not-idle` instead of queuing.
    pub(in crate::session) async fn request_rpc_if_idle(
        &self,
        cmd: Value,
        timeout_ms: u64,
        refusal_message: &str,
    ) -> Result<Value, AgentError> {
        let proc = {
            let state = self.state.lock().await;
            if matches!(
                state.status,
                SessionStatus::Working | SessionStatus::NeedsYou
            ) {
                return Err(AgentError::new(
                    "not-idle",
                    format!("{refusal_message} after the current turn."),
                ));
            }
            state.process.clone().ok_or_else(|| {
                AgentError::new(
                    "agent-not-running",
                    format!(
                        "SessionAgent {}: cannot send, no live process",
                        self.session_id
                    ),
                )
            })?
        };
        proc.request(cmd, timeout_ms)
            .await
            .map_err(|err| AgentError::new("prompt-failed", err.to_string()))
    }

    /// Like `send()`, but refuses mid-turn instead of queuing. Checks idle and takes the
    /// process handle under one lock.
    pub(in crate::session) async fn send_if_idle(
        &self,
        text: String,
        images: Option<Vec<Value>>,
    ) -> Result<Value, AgentError> {
        let proc = {
            let mut state = self.state.lock().await;
            if matches!(
                state.status,
                SessionStatus::Working | SessionStatus::NeedsYou
            ) {
                return Err(AgentError::new(
                    "not-idle",
                    "Switch the model after the current turn.",
                ));
            }
            state.transcript.mark_user_acted();
            state.process.clone().ok_or_else(|| {
                AgentError::new(
                    "agent-not-running",
                    format!(
                        "SessionAgent {}: cannot send, no live process",
                        self.session_id
                    ),
                )
            })?
        };
        let mut cmd = json!({ "type": "prompt", "message": text });
        if let Some(images) = images {
            if !images.is_empty() {
                cmd["images"] = Value::Array(images);
            }
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
            return Err(AgentError::new(
                "prompt-failed",
                format!("prompt failed: {err_message}"),
            ));
        }
        Ok(json!({ "queued": false }))
    }

    /// Returns `true` if the reapply must queue because the Session is working. Atomic with the
    /// status read, so a settle cannot lose it.
    pub(in crate::session) async fn queue_role_reapply_or_ready(&self, role: &str) -> bool {
        let mut state = self.state.lock().await;
        if matches!(
            state.status,
            SessionStatus::Working | SessionStatus::NeedsYou
        ) {
            state.model.pending_role_reapply = Some(role.to_string());
            true
        } else {
            false
        }
    }

    /// Runs `store` only while the Session is not idle, under the same lock as the status read.
    pub(in crate::session) async fn store_pending_unless_idle(
        &self,
        store: impl FnOnce(&mut crate::session::model::State),
    ) -> bool {
        let mut state = self.state.lock().await;
        if state.status == SessionStatus::Idle {
            return false;
        }
        store(&mut state.model);
        true
    }

    /// The Session's pending requests, for a lane that must act on ones already waiting.
    pub(in crate::session) async fn pending_requests(&self) -> Vec<super::PendingRequest> {
        self.state.lock().await.pending.clone()
    }

    /// Transcript notice for a lane (Away mode records its automatic actions this way).
    pub(in crate::session) async fn lane_notice(&self, text: String, level: &str) {
        self.append_notice(text, level).await;
    }

    /// Reads status and process presence under the lane's own lock, so a turn cannot start between them.
    pub(in crate::session) async fn with_working_mode_and_status<R>(
        &self,
        f: impl FnOnce(&mut crate::session::working_mode::State, SessionStatus, bool) -> R,
    ) -> R {
        let mut state = self.state.lock().await;
        let (status, has_process) = (state.status, state.process.is_some());
        f(&mut state.working_mode, status, has_process)
    }

    /// Whether an OMP process is currently recorded for the Session.
    pub(in crate::session) async fn has_process(&self) -> bool {
        self.state.lock().await.process.is_some()
    }

    /// The Conversation file path, or `None` for a Session that has never sent a message.
    pub(in crate::session) async fn current_conversation_path(&self) -> Option<String> {
        self.registry
            .lock()
            .await
            .get_session(&self.session_id)?
            .current_conversation
            .clone()
    }

    /// Re-reads `get_state`, applies it, and returns the raw `model` object. Failures are non-fatal.
    pub(in crate::session) async fn refresh_from_state(&self) -> Result<Value, AgentError> {
        let res = self
            .request_rpc(json!({ "type": "get_state" }), DEFAULT_REQUEST_TIMEOUT_MS)
            .await?;
        if res.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(AgentError::new("prompt-failed", "get_state failed"));
        }
        let data = res.get("data").cloned().unwrap_or(Value::Null);
        self.sync_from_state(&data, None).await;
        Ok(data)
    }

    /// Computes `currentRole` and `pinned` outside `state.lock()`, since `current_selection` locks too.
    pub(in crate::session) async fn role_summary_fields(&self) -> (Value, bool) {
        let (pinned, current_role) = crate::session::model::current_selection(self).await;
        let current_role_value = if pinned {
            Value::Null
        } else {
            current_role.map(Value::String).unwrap_or(Value::Null)
        };
        (current_role_value, pinned)
    }
}
