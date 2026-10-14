// Prompt / stop / remove-queued (`chat.send`/`.stop`/`.removeQueued`). See `mod.rs`'s own header
// for this module's place in the `agent/` split and the lane extension contract.

use serde_json::{json, Value};

use super::{
    AgentError, SessionAgent, SessionStatus, ABORT_SETTLE_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS,
};

impl SessionAgent {
    /// `chat.send` (contracts/omp-usage.md "Send a message"): `message`, never `text`
    /// (constitution II). `images` is only attached when non-empty, matching `streamingBehavior`
    /// only being set while the turn is already `working`/`needs-you` (a steer/follow-up).
    pub async fn send(
        &self,
        text: String,
        images: Option<Vec<Value>>,
    ) -> Result<Value, AgentError> {
        let (proc, working) = {
            let mut state = self.state.lock().await;
            // Port of `SessionAgent.ts`'s own `send()`: marks the user as having acted before
            // anything else (code-review finding, 2026-10-13 -- this was never called, so every
            // notice/`command_output` kept the `startup-notice:` id and stayed hidden,
            // `Transcript.tsx:423`).
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
        let mut cmd = json!({ "type": "prompt", "message": text });
        if let Some(images) = images {
            if !images.is_empty() {
                cmd["images"] = Value::Array(images);
            }
        }
        if working {
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

    /// `chat.stop` (contracts/omp-usage.md "Stop"): sends `abort`, then waits for the turn to
    /// fully settle before the Session accepts another prompt. A no-op while idle or with no
    /// live process.
    pub async fn stop(&self) -> Result<(), AgentError> {
        let (proc, status) = {
            let state = self.state.lock().await;
            (state.process.clone(), state.status)
        };
        let Some(proc) = proc else { return Ok(()) };
        if status == SessionStatus::Idle {
            return Ok(());
        }
        if let Ok(res) = proc
            .request(json!({ "type": "abort" }), DEFAULT_REQUEST_TIMEOUT_MS)
            .await
        {
            if res.get("success").and_then(Value::as_bool) != Some(true) {
                let err_message = res
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown error")
                    .to_string();
                self.append_notice(format!("abort failed: {err_message}"), "error")
                    .await;
            }
        }
        let mut rx = self.status_tx.subscribe();
        if matches!(*rx.borrow(), SessionStatus::Idle | SessionStatus::Stopped) {
            return Ok(());
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
            return Err(AgentError::new(
                "prompt-failed",
                format!(
                    "SessionAgent {}: timed out waiting for idle",
                    self.session_id
                ),
            ));
        }
        Ok(())
    }

    /// `chat.removeQueued` (issue #540): `queue` is the chip's own queue (`'followUp'` or
    /// `'steering'`) -- OMP's `remove_queued_message` only matches within the exact queue given.
    pub async fn remove_queued(&self, text: String, queue: &str) -> Result<Value, AgentError> {
        let proc = {
            self.state.lock().await.process.clone().ok_or_else(|| {
                AgentError::new(
                    "agent-not-running",
                    format!(
                        "SessionAgent {}: cannot remove a queued message, no live process",
                        self.session_id
                    ),
                )
            })?
        };
        let res = proc
            .request(
                json!({ "type": "remove_queued_message", "message": text, "queue": queue }),
                DEFAULT_REQUEST_TIMEOUT_MS,
            )
            .await
            .map_err(|err| AgentError::new("prompt-failed", err.to_string()))?;
        if res.get("success").and_then(Value::as_bool) != Some(true) {
            let err_message = res
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
                .to_string();
            let detail = format!("remove_queued_message failed: {err_message}");
            self.append_notice(detail.clone(), "error").await;
            return Err(AgentError::new("prompt-failed", detail));
        }
        let removed = res
            .get("data")
            .and_then(|d| d.get("removed"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok(json!({ "removed": removed }))
    }

    /// `chat.sendNow` (contracts/omp-usage.md "Send now (steer)", issue #540): a single atomic
    /// `promote_queued_message` call -- OMP moves the existing queued follow-up (attachments and
    /// any contiguous hidden companions included) to the end of the steering queue, with no
    /// reprocessing and no duplicate, replacing a hand-made remove-then-steer that could leave a
    /// message removed from the queue but never steered if the steer half failed. Only ever
    /// called for a follow-up chip (the renderer offers "Send now" on follow-up chips only,
    /// matching `promote_queued_message`'s own semantics: it never matches a steering-queue
    /// message). `promoted: false` means it was no longer pending at dispatch time (e.g.
    /// already delivered).
    pub async fn send_now(&self, text: String) -> Result<Value, AgentError> {
        let proc = {
            self.state.lock().await.process.clone().ok_or_else(|| {
                AgentError::new(
                    "agent-not-running",
                    format!(
                        "SessionAgent {}: cannot send now, no live process",
                        self.session_id
                    ),
                )
            })?
        };
        let res = proc
            .request(
                json!({ "type": "promote_queued_message", "message": text }),
                DEFAULT_REQUEST_TIMEOUT_MS,
            )
            .await
            .map_err(|err| AgentError::new("prompt-failed", err.to_string()))?;
        if res.get("success").and_then(Value::as_bool) != Some(true) {
            let err_message = res
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
                .to_string();
            let detail = format!("promote_queued_message failed: {err_message}");
            self.append_notice(detail.clone(), "error").await;
            return Err(AgentError::new("prompt-failed", detail));
        }
        let promoted = res
            .get("data")
            .and_then(|d| d.get("promoted"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok(json!({ "promoted": promoted }))
    }
}
