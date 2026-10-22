// Lane-extension RPC/role-reapply helpers (lane RM, issues #454, #740, #741, #762, #766): split
// out of `mod.rs` itself (code-review finding: pushed `mod.rs` over this build's 600-line cap)
// into its own `impl SessionAgent` block, the same way `chat.rs`/`conversations.rs`/`launch.rs`
// already split other concerns out of this module. See `mod.rs`'s own header for the lane
// extension contract these exist to serve.

use serde_json::{json, Value};

use super::{AgentError, SessionAgent, SessionStatus, DEFAULT_REQUEST_TIMEOUT_MS};

impl SessionAgent {
    /// Generic RPC passthrough for a lane module (lane RM's `session::model`): same
    /// `state.process.clone()` + error mapping as `chat.rs`'s own `send()`. No idle check of its
    /// own -- see `request_rpc_if_idle` below for the atomic version every lane call that
    /// changes the model/role now uses instead (gate-fix, HIGH: the old two-step "check idle,
    /// then call this" had a race window a concurrent turn start could land in).
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

    /// Gate-fix (HIGH, race): checking `state.status` and cloning `state.process` happen under
    /// the SAME lock acquisition here, so nothing can start a turn between "confirmed idle" and
    /// "process handle taken". Refuses with `not-idle` (never queues) if the Session is working
    /// at that exact instant. Lane RM's `set_model`/`cycle_model` use this for every RPC that
    /// changes the live model.
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

    /// `send()`'s own atomic-idle sibling (gate-fix, HIGH, race): `send()` itself always allows
    /// a mid-turn call to queue as a follow-up (`streamingBehavior`), which is exactly what lane
    /// RM's own `/switch`/`/role` text commands must never do (refusal, not queuing). Checks
    /// `state.status` and takes `state.process`/marks-user-acted under the SAME lock
    /// acquisition, then sends a plain `prompt` with no `streamingBehavior` field at all (this
    /// path only ever runs while idle).
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

    /// Gate-fix (HIGH, race, #740): atomically decides whether a Settings-triggered role reapply
    /// must be queued (the Session is working right now) or can run immediately -- the old code
    /// read `status()` and wrote `pending_role_reapply` as two SEPARATE lock acquisitions, so a
    /// settle landing between them lost the reapply until the Session's NEXT turn ended. Returns
    /// `true` when queued (`on_frame`'s own settle hook applies it later), `false` when idle at
    /// this exact instant (the caller must call `apply_role_now` itself right away).
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

    /// #766 part A: runs `store` on the model state only while the Session is NOT idle, under the
    /// same lock acquisition as the status read (no gap a settle could land in). `false` means
    /// the Session is idle and the caller must apply the choice now.
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

    /// The Session's own current Conversation file path, if any (registry lookup; #741: reading
    /// its latest `model_change` role needs this). `None` for a brand-new Session that has
    /// never sent its first message.
    pub(in crate::session) async fn current_conversation_path(&self) -> Option<String> {
        self.registry
            .lock()
            .await
            .get_session(&self.session_id)?
            .current_conversation
            .clone()
    }

    /// Re-reads `get_state`, applies it via `sync_from_state`, and returns the raw `data` object
    /// (FINDINGS item 30: `model = {provider, id, name?}`) so a lane (RM's own `set_model`/
    /// `cycle_model`/role switch) can refresh the composer label/notice itself. Best-effort:
    /// failures are non-fatal to the caller.
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

    /// Issue #740/#741 (lane RM): `summary_fields`'s own `currentRole`/`pinned` fields for a
    /// `sessions.list()` row, computed OUTSIDE `state.lock()` (gate-fix, file-size: moved out of
    /// `mod.rs` itself to keep it under this build's 600-line cap) -- `current_selection` needs
    /// its own `with_model_state` lock, so calling it while `mod.rs` already holds `state.lock()`
    /// would deadlock (the same `tokio::sync::Mutex`, not reentrant).
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
