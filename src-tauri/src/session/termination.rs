// Agent termination (#656 races), recovery and resume as a typed state machine (lane R3, issue
// #786). Pre-declared so lane R3 is the only lane that ever edits this file (issue #784,
// "Pre-declare per-lane Rust files"). NOTE: #515 ("a reattach that fails with 'Could not
// restore model' is surfaced and offers another model") is NOT covered here or anywhere in this
// PR -- see the PR body's own "Open problems" and the comment on issue #786:
// https://github.com/stuarthopwood/refract/issues/786#issuecomment-6159934897
//
// Port of three Electron modules: `src/main/omp/terminationDetection.ts` (tail-only crash
// detection, issue #510, split into the sibling `termination_detection.rs` round 4, 2026-10-14,
// issue #806 600-line cap), `src/main/omp/stoppedOnRequestMarker.ts` (the persisted "this stop
// was requested, not a crash" marker and the shared `resolveTermination` gate), and the
// `SessionAgent.onExit` requested/crash branches that drive both (ported here, not in
// `agent/frame.rs`, per this lane's own extension-point contract -- see `agent/mod.rs`'s header).
//
// `on_frame` is the one extension point `agent::frame`'s own `handle_frame` calls for every
// decoded frame, `on_exit` for process exit (`agent::launch`'s own `spawn_frame_listener`), and
// `on_start_progress` for the ready-wait banner (same listener) -- one call per lane module each,
// cheap and allocation-free as a no-op; lane R3 adds its termination/recovery behaviour inside
// these functions, never inside any file under `session/agent/`.

use serde_json::Value;

use crate::omp::process::ReadyWaitStage;
use crate::store::registry::{Session, SessionPatch};

use super::agent::SessionAgent;

#[path = "termination_detection.rs"]
mod termination_detection;
use termination_detection::detect_unexpected_termination;

/// Lane R3's own runtime state, held inside `AgentState` by `agent/mod.rs` without that file
/// ever needing to change when this lane adds a field here. Reachable through `SessionAgent`'s
/// own `with_termination_state` accessor (`agent/mod.rs`), and read directly by
/// `agent/mod.rs`'s own `status_event_locked`/`runtime_view` (same module tree, `pub(super)`
/// fields) to embed `terminatedUnexpectedly`/`pendingToolNames` into the wire payload.
#[derive(Default)]
pub(super) struct State {
    /// This life's own in-memory flag (`SessionRuntime.stoppedOnRequest`): set by `on_exit`'s
    /// requested branch, cleared at the top of every `launch()` attempt
    /// (`clear_stopped_on_request_marker`). Lets `resolve_termination` skip the tail read
    /// entirely for a Session this life itself stopped on request.
    pub(super) stopped_on_request: bool,
    pub(super) terminated_unexpectedly: bool,
    pub(super) pending_tool_names: Vec<String>,
    /// Gate-fix (code review MEDIUM, round 3): bumped by `clear_stopped_on_request_marker`
    /// (every `launch()` attempt, i.e. every new "life"). `record_stopped_on_request_marker`
    /// captures this BEFORE its own `fs::metadata` await and re-checks it AFTER, so a
    /// `on_exit(requested=true)` racing a quick `Recover`'s own `clear` (which runs while this
    /// call's stat is still in flight) can never re-arm the marker for the NEW life that clear
    /// started -- the `stillCurrent`/`lifeEpoch` guard `stoppedOnRequestMarker.ts` has, this
    /// port previously lacked. `pub(super)` (round 6, code review MEDIUM): `agent::frame`'s own
    /// `handle_exit` reads this directly (`state.termination.epoch`), under the SAME lock
    /// acquisition that reads `is_current`/`stop_requested` and clears `state.process`, so the
    /// epoch `on_exit` later checks every write against is captured atomically with those --
    /// a separate `with_termination_state` call afterward (the previous approach) left a window
    /// for a concurrent Recover to bump it first.
    pub(super) epoch: u64,
}

/// Port of `terminationDetection.ts`'s own `TerminationDetectionResult`, narrowed to the two
/// fields anything outside this module ever reads (`reason` is internal detail, not surfaced on
/// the wire -- `src/shared/ipc.ts`'s `SessionRuntimeView` only carries
/// `terminatedUnexpectedly`/`pendingToolNames`).
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

// ---------------------------------------------------------------------------------------------
// Persisted stopped-on-request marker (port of `stoppedOnRequestMarker.ts`)
// ---------------------------------------------------------------------------------------------

/// Writes the marker for `conversation` at the moment of a requested stop (`on_exit`'s requested
/// branch, below). Stats the file for its exact size rather than trusting any in-memory byte
/// count. A missing/unreadable Conversation (the agent stopped before its first turn) sets no
/// marker. Never fails the caller: a write failure here must not crash the exit handler it runs
/// from.
///
/// `epoch_at_exit` (gate-fix, code review MEDIUM, round 3): captured by the caller BEFORE this
/// function's own `fs::metadata` await; re-checked against the live `State::epoch` AFTER it,
/// closing the race where a quick `Recover`'s own `clear_stopped_on_request_marker` (which bumps
/// `epoch`) runs while this call's stat is still in flight -- without the re-check, this call
/// would then re-arm the marker for the NEW life `clear` just started protecting, rather than
/// leave it cleared.
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
    // Gate-fix (round 4, security review MEDIUM): the registry lock is now acquired BEFORE the
    // epoch re-check and held across it AND the write below, not released in between -- the
    // previous shape (check epoch, release, THEN separately acquire the registry lock to write)
    // left a window where a `clear_stopped_on_request_marker` landing in exactly that gap could
    // bump the epoch AFTER this call's own check already passed, letting a stale write through
    // anyway. No other caller can observe or mutate the registry between the check and this
    // call's own write while this guard is held.
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

/// True only when `session` carries a marker for its OWN current Conversation whose recorded
/// size still matches that file's real size on disk right now. Any mismatch returns `false`:
/// judge the tail fresh, exactly as if no marker had ever existed. Never panics.
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

/// Port of `resolveTermination`: the "requested stop (in-memory flag or a valid persisted
/// marker) -> clean, else read the tail" rule every call site routes through. `pub(super)`
/// (lane R3, issue #786, gate-fix): `session::manager`'s own `summaries()` calls this directly
/// for a Session with no LIVE agent this run (nothing to call `resolve_termination()`'s own
/// `SessionAgent` method through).
pub(super) async fn resolve_termination_for(
    session: &Session,
    stopped_on_request: bool,
) -> TerminationDetectionResult {
    if stopped_on_request || is_stopped_on_request_marker_valid(session).await {
        return TerminationDetectionResult::clean();
    }
    detect_unexpected_termination(session.current_conversation.as_deref()).await
}

/// Lane R3/#786 follow-up: the raw, UNGATED tail read `session::agent::launch`'s `launch()` and
/// `session::agent::conversations`'s `open_conversation()` call right before building/merging
/// the transcript, so an unresolved `tool` row left by a crashed previous life settles to
/// `interrupted` (`omp::transcript::TranscriptState::merge_from_history`/
/// `set_terminated_unexpectedly` + `settle_interrupted_tool_rows`) instead of spinning `running`
/// forever. Port of `SessionAgent.ts` calling `detectUnexpectedTermination(file)` directly at
/// its own `fromHistory` call sites -- 3 in TS (`launch()` line 626, `openConversation()` line
/// 1221, and `switchRecovery.ts`'s own recovery path line 50); only the first two have a Rust
/// equivalent (this file's own header: #515's reattach-retry recovery is out of scope for this
/// PR, so Rust just stops the process there instead of recovering it). Deliberately NOT routed
/// through `resolve_termination_for`'s `stoppedOnRequest`/marker gate above: that gate answers a
/// different question ("was this exit a deliberate stop, so skip showing a crash banner"),
/// while the transcript only needs "does the tail show an unresolved tool call right now",
/// which stays true even for a session that stopped on request mid-tool-call. Always a fresh
/// read against `file` (never a cached `State::terminated_unexpectedly` from an earlier
/// `on_exit` this run), matching `resolve_termination`'s own doc comment: a Session reattached
/// after a crash in a PREVIOUS run has no live `on_exit` to have computed anything yet.
pub(crate) async fn detect_unexpected_termination_for_transcript(file: Option<&str>) -> bool {
    detect_unexpected_termination(file)
        .await
        .terminated_unexpectedly
}

impl SessionAgent {
    /// `sessions.open`/`.recover`/`.resume` (`ipc::sessions_agent`): a FRESH read each call,
    /// never trusting a cached flag from an earlier `on_exit` this run -- a Session that crashed
    /// in a PREVIOUS run has no live `on_exit` to have computed anything yet.
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

    /// Called at the top of every `launch()` attempt (`agent::launch`'s own "one hook"): a new
    /// life starting means whatever the PREVIOUS life's requested stop protected no longer
    /// applies to THIS one.
    pub(super) async fn clear_stopped_on_request_marker(&self) {
        self.with_termination_state(|s| {
            // Gate-fix (code review MEDIUM, round 3): bumped BEFORE anything else below -- see
            // `State::epoch`'s own doc comment for the race this closes.
            s.epoch = s.epoch.wrapping_add(1);
            s.stopped_on_request = false;
            // Gate-fix: a new life starting means whatever the PREVIOUS life's crash banner
            // showed no longer applies either -- `on_exit` will recompute a fresh verdict for
            // THIS life if it too ends unexpectedly, but until then nothing is wrong.
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
        // Perf gate-fix: every `launch()` attempt calls this, the overwhelming majority with no
        // marker set at all (a fresh Session, or one that last stopped on a genuine crash, never
        // a requested stop) -- skip the registry write (and the event it would broadcast)
        // entirely rather than pay it on every single start for nothing to actually clear.
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
    // No-op: termination is judged from the Conversation file tail at exit time, not from any
    // live frame.
}

/// Port of `SessionAgent.onExit`'s requested/crash branches (issue #510's own
/// `detectUnexpectedTermination`/`stoppedOnRequestMarker` consultation), kept here rather than in
/// `agent/frame.rs`'s own `handle_exit` per this lane's extension-point contract. Runs AFTER
/// `agent::frame`'s own `handle_exit` has already set `status`/`stopReason` and emitted once;
/// this computes the (possibly file-read-bound) termination verdict and re-emits so the crash
/// banner appears without the renderer needing to re-open the Session. `agent::frame`'s own
/// dispatch gates this call on `is_current` (never invoked for a stale exit belonging to an
/// already-superseded life).
///
/// `requested`/`stop_requested` (gate-fix, code review round 3): BOTH are needed, not just
/// `stop_requested` alone. `requested && !stop_requested` (the raw `ProcessEvent::Exit`'s own
/// flag true, but the Session's own `stop_requested` false) is a `launch()`-internal cleanup
/// stop (failed handshake/attach, or a plain `cancelStart()`'s own `proc.stop()`) -- `handle_exit`
/// itself already returns early for exactly this case (its own doc comment), and this hook must
/// too: neither a clean-stop marker NOR a crash-tail read applies to it, `launch()`'s own catch
/// path already recorded the real status. `was_already_stopped` (status read at the very top of
/// `handle_exit`, before anything else) skips this hook entirely once something MORE
/// authoritative already settled this life's status before this exit event was even processed --
/// the same race `should_apply_crash_exit_verdict`/`set_stopped_unless_already_stopped` guards
/// for `handle_exit`'s own write, which this hook did not previously consult at all (it could
/// still read a stale tail and set `terminatedUnexpectedly` on top of an unrelated
/// `reattach-failed`/`start-failed`).
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
    // Gate-fix (code review MEDIUM, round 6): `epoch_at_exit` is captured by the caller
    // (`agent::frame`'s own `handle_exit`) under the SAME lock acquisition that reads
    // `is_current`/`stop_requested`/`was_already_stopped` and clears `state.process` -- the
    // read used to happen HERE instead, after this function's own registry `get_session` await,
    // which left a window for a concurrent Recover's `clear_stopped_on_request_marker` (which
    // bumps `epoch`) to run first and make this stale exit look like it belongs to the life
    // `clear` just started protecting. Every write below now also re-checks `s.epoch ==
    // epoch_at_exit` INSIDE its own `with_termination_state` closure (not just once up front):
    // `detect_unexpected_termination`'s own file read can take a moment, during which another
    // Recover could bump the epoch again, so only a check atomic with the write itself closes
    // the race for every state mutation, not merely the persisted marker (already epoch-guarded
    // in `record_stopped_on_request_marker`).
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
