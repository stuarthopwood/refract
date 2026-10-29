// Pause mode (issue #477, spec 056). OMP has no RPC pause (can1357/oh-my-pi#17371), so Refract
// runs the safe point itself at the turn boundary: the running turn finishes, queued messages
// are withdrawn from OMP's queue, and new sends are held here until Resume.
//
// `State.held` is `Some` while paused or pausing (the texts held back, text only). The wire value
// `pausing` vs `paused` is derived from the Session status, never stored: `pausing` while a turn
// is still running, `paused` once it settles. The held list mirrors to `Session.paused_held` in
// the registry so a pause survives app and agent restarts and never auto-resumes.

use serde_json::{json, Value};

use crate::store::registry::SessionPatch;

use super::{
    AgentError, AgentState, SessionAgent, SessionStatus, DEFAULT_REQUEST_TIMEOUT_MS,
};

#[derive(Default)]
pub(super) struct State {
    loaded: bool,
    held: Option<Vec<String>>,
}

/// Pure: `pausing` while a turn is running, `paused` otherwise, `None` when not paused.
pub(super) fn wire_value(state: &AgentState) -> Option<&'static str> {
    state.pause.held.as_ref().map(|_| {
        if matches!(
            state.status,
            SessionStatus::Working | SessionStatus::NeedsYou
        ) {
            "pausing"
        } else {
            "paused"
        }
    })
}

/// Pure: a stopped Session with persisted held messages is still Paused.
pub fn mark_stopped(object: &mut serde_json::Map<String, Value>, held: &Option<Vec<String>>) {
    if held.is_some() {
        object.insert("pause".to_string(), "paused".into());
    }
}

/// Pure: OMP's own queued messages followed by the held ones, for the chip row.
pub(super) fn queue_view(
    state: &AgentState,
    follow_up: &[String],
    steering: &[String],
) -> (Vec<String>, Vec<String>) {
    let mut merged = follow_up.to_vec();
    if let Some(held) = &state.pause.held {
        merged.extend(held.iter().cloned());
    }
    (merged, steering.to_vec())
}

impl SessionAgent {
    /// Loads the persisted pause once per agent, before the first status or send.
    pub(super) async fn ensure_pause_loaded(&self) {
        if self.state.lock().await.pause.loaded {
            return;
        }
        let persisted = self
            .registry
            .lock()
            .await
            .get_session(&self.session_id)
            .and_then(|s| s.paused_held.clone());
        let mut state = self.state.lock().await;
        if !state.pause.loaded {
            state.pause.loaded = true;
            if state.pause.held.is_none() {
                state.pause.held = persisted;
            }
        }
    }

    async fn persist_pause(&self, held: Option<Vec<String>>) {
        let result = self
            .registry
            .lock()
            .await
            .update_session(
                &self.session_id,
                SessionPatch {
                    paused_held: Some(held),
                    ..Default::default()
                },
            )
            .await;
        if let Err(err) = result {
            log::warn!("pause: could not persist for {}: {err:?}", self.session_id);
        }
    }

    async fn emit_pause_queue(&self) {
        let (follow_up, steering) = {
            let state = self.state.lock().await;
            queue_view(&state, &state.queue_follow_up, &state.queue_steering)
        };
        self.events
            .emit_queue_update(&self.session_id, &follow_up, &steering);
    }

    pub async fn is_paused(&self) -> bool {
        self.ensure_pause_loaded().await;
        self.state.lock().await.pause.held.is_some()
    }

    /// `chat.pause`: the running turn finishes; queued messages are withdrawn into the held list.
    pub async fn pause(&self) -> Result<Value, AgentError> {
        self.ensure_pause_loaded().await;
        let (has_process, follow_up, steering) = {
            let mut state = self.state.lock().await;
            if state.pause.held.is_some() {
                return Ok(json!({ "paused": true }));
            }
            state.pause.held = Some(Vec::new());
            (
                state.process.is_some(),
                state.queue_follow_up.clone(),
                state.queue_steering.clone(),
            )
        };
        if has_process {
            for (queue, texts) in [("followUp", follow_up), ("steering", steering)] {
                for text in texts {
                    let removed = self
                        .queue_op(
                            json!({ "type": "remove_queued_message", "message": text, "queue": queue }),
                            "remove_queued_message",
                            "cannot withdraw a queued message, no live process",
                        )
                        .await
                        .ok()
                        .and_then(|data| data.get("removed").and_then(Value::as_bool))
                        .unwrap_or(false);
                    if removed {
                        if let Some(held) = self.state.lock().await.pause.held.as_mut() {
                            held.push(text);
                        }
                    }
                }
            }
        }
        let held = self.state.lock().await.pause.held.clone();
        self.persist_pause(held).await;
        self.emit_status().await;
        self.emit_pause_queue().await;
        Ok(json!({ "paused": true }))
    }

    /// `chat.resume`: clears the pause and sends the held messages in order. With held messages
    /// and no live process the pause stays and the caller sees `agent-not-running`.
    pub async fn resume(&self) -> Result<Value, AgentError> {
        self.ensure_pause_loaded().await;
        let (proc, working, held) = {
            let mut state = self.state.lock().await;
            let Some(held) = state.pause.held.clone() else {
                return Ok(json!({ "paused": false }));
            };
            let proc = state.process.clone();
            if proc.is_none() && !held.is_empty() {
                return Err(AgentError::new(
                    "agent-not-running",
                    "Start the agent before resuming: held messages are waiting.",
                ));
            }
            state.pause.held = None;
            let working = matches!(
                state.status,
                SessionStatus::Working | SessionStatus::NeedsYou
            );
            (proc, working, held)
        };
        self.persist_pause(None).await;
        self.emit_status().await;
        self.emit_pause_queue().await;
        if let Some(proc) = proc {
            for (index, text) in held.into_iter().enumerate() {
                let mut cmd = json!({ "type": "prompt", "message": text });
                if working || index > 0 {
                    cmd["streamingBehavior"] = Value::String("followUp".to_string());
                }
                let res = proc
                    .request(cmd, DEFAULT_REQUEST_TIMEOUT_MS)
                    .await
                    .map_err(|err| AgentError::new("prompt-failed", err.to_string()))?;
                if res.get("success").and_then(Value::as_bool) != Some(true) {
                    return Err(AgentError::new("prompt-failed", "a held message failed to send"));
                }
            }
        }
        Ok(json!({ "paused": false }))
    }

    pub async fn toggle_pause(&self) -> Result<Value, AgentError> {
        if self.is_paused().await {
            self.resume().await
        } else {
            self.pause().await
        }
    }

    /// `send` gate: while paused, holds the text instead of sending it. `Ok(None)` = not paused.
    pub(super) async fn hold_if_paused(
        &self,
        text: &str,
        images: &Option<Vec<Value>>,
    ) -> Result<Option<Value>, AgentError> {
        self.ensure_pause_loaded().await;
        let held = {
            let mut state = self.state.lock().await;
            let Some(held) = state.pause.held.as_mut() else {
                return Ok(None);
            };
            if images.as_ref().is_some_and(|i| !i.is_empty()) {
                return Err(AgentError::new(
                    "paused-images",
                    "Images can't be queued while paused. Resume first, or send text only.",
                ));
            }
            held.push(text.to_string());
            held.clone()
        };
        self.persist_pause(Some(held)).await;
        self.emit_pause_queue().await;
        Ok(Some(json!({ "queued": true })))
    }

    /// `remove_queued` gate: a chip for a held message is removed from the held list.
    pub(super) async fn remove_held(&self, text: &str) -> bool {
        self.ensure_pause_loaded().await;
        let held = {
            let mut state = self.state.lock().await;
            let Some(held) = state.pause.held.as_mut() else {
                return false;
            };
            let Some(index) = held.iter().position(|t| t == text) else {
                return false;
            };
            held.remove(index);
            held.clone()
        };
        self.persist_pause(Some(held)).await;
        self.emit_pause_queue().await;
        true
    }
}
