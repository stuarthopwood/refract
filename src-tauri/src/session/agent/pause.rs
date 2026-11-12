// Pause mode. OMP has no RPC pause, so Refract holds sends and withdraws queued messages at the turn boundary.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};

use crate::store::registry::{RegistryStoreError, SessionPatch};

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
    /// Ids Pause cancelled; cleared on Resume and never persisted, since a restart loses the subagents anyway.
    pub(super) cancelled: Vec<String>,
}

impl State {
    /// True while Pause holds sends and cancels subagents. A resuming Session has stopped gating,
    /// so what its drain spawns runs and a Pause RPC still in flight is stale.
    pub(super) fn is_gating(&self) -> bool {
        self.held.is_some() && !self.resuming
    }
}

/// Seams for tests in sibling modules: `held` and `resuming` stay private so only this file changes them.
#[cfg(test)]
impl State {
    pub(super) fn hold_for_test(&mut self, texts: Vec<String>) {
        self.held = Some(texts);
    }

    pub(super) fn mark_resuming_for_test(&mut self) {
        self.resuming = true;
    }
}

/// Derived from status, never stored, so `pausing` vs `paused` cannot drift.
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

/// A stopped Session with persisted held messages stays paused.
pub fn mark_stopped(object: &mut serde_json::Map<String, Value>, held: &Option<Vec<String>>) {
    if held.is_some() {
        object.insert("pause".to_string(), "paused".into());
    }
}

/// OMP's queued messages come first, then the held ones.
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

/// Resumes every paused, unarchived Session and returns `(resumed, failed)`. A Resume already in
/// flight answers `paused: true`; it is neither, since that Resume owns the outcome.
pub async fn resume_all(
    registry: &super::SharedRegistry,
    manager: &crate::session::manager::SessionManager,
) -> (u32, u32) {
    let ids: Vec<String> = registry
        .lock()
        .await
        .snapshot()
        .sessions
        .into_iter()
        .filter(|s| s.paused_held.is_some() && s.archived_at.is_none())
        .map(|s| s.id)
        .collect();
    let (mut resumed, mut failed) = (0, 0);
    for id in ids {
        match manager.get_or_create_agent(&id).resume().await {
            Ok(value) if value["paused"] == false => resumed += 1,
            Ok(_) => {}
            Err(err) => {
                log::warn!("resume all: a Session did not start: {} ({})", id, err.code);
                failed += 1;
            }
        }
    }
    (resumed, failed)
}

impl SessionAgent {
    /// Loads the persisted pause once per agent.
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

    /// Writes the held list. Stale snapshots are skipped to keep writes in order.
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
            // Log only the code/kind: the registry message can embed the session id.
            match err {
                RegistryStoreError::Registry(e) => {
                    log::warn!(
                        "pause: could not persist the held queue: {}",
                        e.code.as_str()
                    );
                }
                RegistryStoreError::Io(e) => {
                    log::warn!("pause: could not persist the held queue: io {:?}", e.kind());
                }
            }
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

    /// `chat.pause`: the running turn finishes, and queued messages move to the held list.
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
        self.cancel_running_subagents().await;
        self.emit_status().await;
        self.emit_pause_queue().await;
        Ok(json!({ "paused": true }))
    }

    /// `chat.resume`: starts a stopped Session's agent, drains held messages in order, then clears the pause.
    /// A failed start or send leaves the Session paused with the unsent messages still held.
    pub async fn resume(&self) -> Result<Value, AgentError> {
        self.ensure_pause_loaded().await;
        let needs_start = {
            let mut state = self.state.lock().await;
            if state.pause.held.is_none() {
                return Ok(json!({ "paused": false }));
            }
            if state.pause.resuming {
                return Ok(json!({ "paused": true }));
            }
            // Set before the start, so a second Resume (Space twice, Resume all) cannot start or drain again.
            state.pause.resuming = true;
            state.process.is_none()
        };
        let outcome = self.start_then_drain(needs_start).await;
        // The list is taken only once the drain succeeded: a failed drain leaves the Session paused and the list intact.
        let cancelled = {
            let mut state = self.state.lock().await;
            state.pause.resuming = false;
            if outcome.is_ok() {
                std::mem::take(&mut state.pause.cancelled)
            } else {
                Vec::new()
            }
        };
        self.persist_pause().await;
        self.emit_status().await;
        self.emit_pause_queue().await;
        if outcome.is_ok() {
            // After the status event: the transcript is inert while paused, so an earlier notice is never announced.
            self.notify_resumed(cancelled).await;
        }
        outcome?;
        Ok(json!({ "paused": false }))
    }

    /// An archived Session never starts here: Resume only clears a pause, it must not revive a hidden agent.
    async fn start_then_drain(&self, needs_start: bool) -> Result<(), AgentError> {
        if needs_start {
            if self.require_session().await?.archived_at.is_some() {
                return Err(AgentError::new(
                    "session-archived",
                    "Restore this Session before resuming it.",
                ));
            }
            self.start().await?;
        }
        self.drain_held().await
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

    /// `send` gate: holds the text while paused. `Ok(None)` means not paused.
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

    /// `remove_queued` gate: removes a held message's chip from the held list.
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

#[cfg(test)]
#[path = "pause.test.rs"]
mod tests;
