// Termination, recovery and resume state machine (#786, #656).
// `on_frame`/`on_exit`/`on_start_progress` are the hooks `session/agent/` calls.

use serde_json::Value;

use crate::omp::process::ReadyWaitStage;
use crate::store::registry::{Session, SessionPatch};

use super::agent::SessionAgent;

#[path = "termination_detection.rs"]
mod termination_detection;
use termination_detection::detect_unexpected_termination;

/// Termination runtime state held inside `AgentState`; its `pub(super)` fields feed the wire payload.
#[derive(Default)]
pub(super) struct State {
    /// In-memory flag set on a requested stop, cleared every `launch()`; lets `resolve_termination` skip the tail read.
    pub(super) stopped_on_request: bool,
    pub(super) terminated_unexpectedly: bool,
    pub(super) pending_tool_names: Vec<String>,
    /// Bumped on every new life so a stale requested-exit cannot re-arm the marker. `handle_exit`
    /// reads it under the same lock as `is_current`/`stop_requested` so the capture is atomic.
    pub(super) epoch: u64,
}

/// Termination verdict narrowed to the two fields the wire payload carries.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct TerminationDetectionResult {
    pub(crate) terminated_unexpectedly: bool,
    pub(crate) pending_tool_names: Vec<String>,
}

impl TerminationDetectionResult {
    fn clean() -> Self {
        Self::default()
    }
}

/// Writes the stop marker with the file's exact size; never fails the caller.
/// `epoch_at_exit` is re-checked after the stat await so a quick Recover cannot re-arm it.
async fn record_stopped_on_request_marker(
    agent: &SessionAgent,
    conversation: Option<&str>,
    epoch_at_exit: u64,
) {
    let Some(conversation) = conversation else {
        return;
    };
    let Ok(metadata) = tokio::fs::metadata(conversation).await else {
        return;
    };
    // Hold the registry lock across the epoch check and the write so a clear cannot slip between.
    let mut registry = agent.registry().lock().await;
    let still_current = agent
        .with_termination_state(|s| s.epoch == epoch_at_exit)
        .await;
    if !still_current {
        return;
    }
    let patch = SessionPatch {
        stopped_on_request_conversation: Some(Some(conversation.to_string())),
        stopped_on_request_at_size: Some(Some(metadata.len() as i64)),
        ..Default::default()
    };
    let _ = registry.update_session(agent.session_id(), patch).await;
}

/// True only when the marker's recorded size still matches the current Conversation file.
async fn is_stopped_on_request_marker_valid(session: &Session) -> bool {
    let Some(current) = &session.current_conversation else {
        return false;
    };
    let Some(marker_conversation) = &session.stopped_on_request_conversation else {
        return false;
    };
    if marker_conversation != current {
        return false;
    }
    let Some(marker_size) = session.stopped_on_request_at_size else {
        return false;
    };
    if marker_size < 0 {
        return false;
    }
    match tokio::fs::metadata(current).await {
        Ok(metadata) => metadata.len() == marker_size as u64,
        Err(_) => false,
    }
}

/// Requested stop (flag or valid marker) means clean, else read the tail; also used by `session::manager` for agentless Sessions.
pub(super) async fn resolve_termination_for(
    session: &Session,
    stopped_on_request: bool,
) -> TerminationDetectionResult {
    if stopped_on_request || is_stopped_on_request_marker_valid(session).await {
        return TerminationDetectionResult::clean();
    }
    detect_unexpected_termination(session.current_conversation.as_deref()).await
}

/// Raw, ungated fresh tail read so a crashed life's unresolved `tool` row settles to `interrupted`.
/// Skips the stop-marker gate on purpose: a requested stop mid-tool-call still leaves the row unresolved.
pub(crate) async fn detect_unexpected_termination_for_transcript(file: Option<&str>) -> bool {
    detect_unexpected_termination(file)
        .await
        .terminated_unexpectedly
}

impl SessionAgent {
    /// Always a fresh read: a Session that crashed in a previous run has no cached verdict.
    pub(crate) async fn resolve_termination(&self) -> TerminationDetectionResult {
        let Some(session) = self
            .registry()
            .lock()
            .await
            .get_session(self.session_id())
            .cloned()
        else {
            return TerminationDetectionResult::clean();
        };
        let stopped_on_request = self.with_termination_state(|s| s.stopped_on_request).await;
        resolve_termination_for(&session, stopped_on_request).await
    }

    /// Called at the top of every `launch()`: the previous life's requested stop no longer applies.
    pub(super) async fn clear_stopped_on_request_marker(&self) {
        self.with_termination_state(|s| {
            // Bump first; see `State::epoch`.
            s.epoch = s.epoch.wrapping_add(1);
            s.stopped_on_request = false;
            // The previous life's crash banner no longer applies; `on_exit` recomputes if needed.
            s.terminated_unexpectedly = false;
            s.pending_tool_names.clear();
        })
        .await;
        let Some(session) = self
            .registry()
            .lock()
            .await
            .get_session(self.session_id())
            .cloned()
        else {
            return;
        };
        // Most launches have no marker; skip the registry write and its broadcast event.
        if session.stopped_on_request_conversation.is_none()
            && session.stopped_on_request_at_size.is_none()
        {
            return;
        }
        let patch = SessionPatch {
            stopped_on_request_conversation: Some(None),
            stopped_on_request_at_size: Some(None),
            ..Default::default()
        };
        let _ = self
            .registry()
            .lock()
            .await
            .update_session(self.session_id(), patch)
            .await;
    }
}

pub(super) async fn on_frame(_agent: &SessionAgent, _frame_type: &str, _frame: &Value) {
    // No-op: termination is judged from the file tail at exit, not live frames.
}

/// Computes the termination verdict after `handle_exit` and re-emits so the crash banner appears.
/// Skips launch-internal cleanup stops and exits a more authoritative status already settled.
pub(super) async fn on_exit(
    agent: &SessionAgent,
    _code: Option<i32>,
    requested: bool,
    stop_requested: bool,
    was_already_stopped: bool,
    epoch_at_exit: u64,
) {
    if requested && !stop_requested {
        return;
    }
    if was_already_stopped {
        return;
    }
    // `epoch_at_exit` is captured atomically by the caller; every write re-checks it inside its
    // own closure because the file read can span another Recover's epoch bump.
    let still_current = agent
        .with_termination_state(|s| s.epoch == epoch_at_exit)
        .await;
    if !still_current {
        return;
    }
    let session = agent
        .registry()
        .lock()
        .await
        .get_session(agent.session_id())
        .cloned();
    if stop_requested {
        agent
            .with_termination_state(|s| {
                if s.epoch != epoch_at_exit {
                    return;
                }
                s.stopped_on_request = true;
                s.terminated_unexpectedly = false;
                s.pending_tool_names.clear();
            })
            .await;
        if let Some(session) = &session {
            record_stopped_on_request_marker(
                agent,
                session.current_conversation.as_deref(),
                epoch_at_exit,
            )
            .await;
        }
    } else {
        agent
            .with_termination_state(|s| {
                if s.epoch != epoch_at_exit {
                    return;
                }
                s.stopped_on_request = false;
            })
            .await;
        let file = session
            .as_ref()
            .and_then(|s| s.current_conversation.clone());
        let result = detect_unexpected_termination(file.as_deref()).await;
        agent
            .with_termination_state(|s| {
                if s.epoch != epoch_at_exit {
                    return;
                }
                s.terminated_unexpectedly = result.terminated_unexpectedly;
                s.pending_tool_names = result.pending_tool_names.clone();
            })
            .await;
    }
    agent.emit_status().await;
}

pub(super) async fn on_start_progress(
    _agent: &SessionAgent,
    _stage: ReadyWaitStage,
    _elapsed_ms: u64,
) {
    // No-op: the start-progress banner is `session::start_queue`'s own concern.
}

#[cfg(test)]
#[path = "termination.test.rs"]
mod tests;
