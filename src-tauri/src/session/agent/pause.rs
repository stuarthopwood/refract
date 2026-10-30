// Pause mode (issue #477, spec 056). OMP has no RPC pause (can1357/oh-my-pi#17371), so Refract
// runs the safe point itself at the turn boundary: the running turn finishes, queued messages
// are withdrawn from OMP's queue, and new sends are held here until Resume.
//
// `State.held` is `Some` while paused or pausing (the texts held back, text only). The wire value
// `pausing` vs `paused` is derived from the Session status, never stored: `pausing` while a turn
// is still running, `paused` once it settles. The held list mirrors to `Session.paused_held` in
// the registry so a pause survives app and agent restarts and never auto-resumes.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};

use crate::store::registry::SessionPatch;

use super::{AgentError, AgentState, SessionAgent, SessionStatus};

const MAX_HELD_MESSAGES: usize = 100;
const MAX_HELD_BYTES: usize = 256 * 1024;

#[derive(Default)]
pub(super) struct State {
    loaded: bool,
    held: Option<Vec<String>>,
    resuming: bool,
    seq: u64,
    written: Arc<AtomicU64>,
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

    /// Writes the current held list. Each call snapshots under the state lock with a rising
    /// sequence number; the registry lock then serialises writes, and a stale snapshot is
    /// skipped, so concurrent mutations can never persist out of order.
    pub(super) async fn persist_pause(&self) {
        let (held, seq, written) = {
            let mut state = self.state.lock().await;
            state.pause.seq += 1;
            (
                state.pause.held.clone(),
                state.pause.seq,
                state.pause.written.clone(),
            )
        };
        let mut registry = self.registry.lock().await;
        if written.load(Ordering::SeqCst) > seq {
            return;
        }
        let result = registry
            .update_session(
                &self.session_id,
                SessionPatch {
                    paused_held: Some(held),
                    ..Default::default()
                },
            )
            .await;
        written.store(seq, Ordering::SeqCst);
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
        self.persist_pause().await;
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
                        self.persist_pause().await;
                    }
                }
            }
        }
        self.emit_status().await;
        self.emit_pause_queue().await;
        Ok(json!({ "paused": true }))
    }

    /// `chat.resume`: drains the held messages in order through the normal send path, then
    /// clears the pause. The pause stays set while draining, so a concurrent send appends behind
    /// the held ones. A failed send leaves the unsent messages held and the Session paused. With
    /// held messages and no live process the pause stays and the caller sees `agent-not-running`.
    pub async fn resume(&self) -> Result<Value, AgentError> {
        self.ensure_pause_loaded().await;
        {
            let mut state = self.state.lock().await;
            let Some(held) = state.pause.held.as_ref() else {
                return Ok(json!({ "paused": false }));
            };
            if state.pause.resuming {
                return Ok(json!({ "paused": true }));
            }
            if state.process.is_none() && !held.is_empty() {
                return Err(AgentError::new(
                    "agent-not-running",
                    "Start the agent before resuming: held messages are waiting.",
                ));
            }
            state.pause.resuming = true;
        }
        let outcome = self.drain_held().await;
        self.state.lock().await.pause.resuming = false;
        self.persist_pause().await;
        self.emit_status().await;
        self.emit_pause_queue().await;
        outcome?;
        Ok(json!({ "paused": false }))
    }

    async fn drain_held(&self) -> Result<(), AgentError> {
        let mut sent = 0;
        loop {
            let next = {
                let mut state = self.state.lock().await;
                match state.pause.held.as_ref().and_then(|h| h.first().cloned()) {
                    Some(text) => text,
                    None => {
                        state.pause.held = None;
                        return Ok(());
                    }
                }
            };
            self.send_unheld(next.clone(), None, sent > 0).await?;
            sent += 1;
            let mut state = self.state.lock().await;
            if let Some(held) = state.pause.held.as_mut() {
                if held.first() == Some(&next) {
                    held.remove(0);
                }
            }
            drop(state);
            self.persist_pause().await;
            self.emit_pause_queue().await;
        }
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
        {
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
            if held.len() >= MAX_HELD_MESSAGES
                || held.iter().map(String::len).sum::<usize>() + text.len() > MAX_HELD_BYTES
            {
                return Err(AgentError::new(
                    "paused-full",
                    "Too many messages are held while paused. Resume first.",
                ));
            }
            held.push(text.to_string());
        };
        self.persist_pause().await;
        self.emit_pause_queue().await;
        Ok(Some(json!({ "queued": true })))
    }

    /// `remove_queued` gate: a chip for a held message is removed from the held list.
    pub(super) async fn remove_held(&self, text: &str) -> bool {
        self.ensure_pause_loaded().await;
        {
            let mut state = self.state.lock().await;
            let Some(held) = state.pause.held.as_mut() else {
                return false;
            };
            let Some(index) = held.iter().position(|t| t == text) else {
                return false;
            };
            held.remove(index);
        };
        self.persist_pause().await;
        self.emit_pause_queue().await;
        true
    }
}
