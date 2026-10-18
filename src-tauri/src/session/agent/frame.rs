// Live frames (port of `SessionAgent.ts`'s own `onFrame`): the listener loop, the one frame-type
// match (including the per-lane `on_frame` extension-point calls right after it), queue/commands
// updates, pending-request dialog routing, turn-settle, and process-exit handling. See `mod.rs`'s
// own header for this module's place in the `agent/` split and the lane extension contract.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::omp::diff::{diff_transcript, SubagentFinalizeCause};
use crate::omp::process::OmpProcess;
use crate::omp::transcript::RequestResolution;

use super::commands::{filter_supported_commands, string_array};
use super::requests::{classify_dialog, DialogClassification};
use super::{PendingRequest, SessionAgent, SessionStatus, DEFAULT_REQUEST_TIMEOUT_MS};

impl SessionAgent {
    pub(super) async fn handle_frame(&self, frame: Value) {
        let frame_type = frame.get("type").and_then(Value::as_str).unwrap_or("");
        match frame_type {
            "agent_start" => {
                {
                    let mut state = self.state.lock().await;
                    // Gate-fix (#856): `turn_generation` replaces the old `turn_settle_handled`
                    // bool via parity -- odd means "mid-turn, not yet settled", even means
                    // "settled" (see `handle_turn_settled`'s own doc comment). Only bumped when
                    // currently even (round 2 LOW: `wrapping_add(1) | 1` added 2, not 1, from an
                    // already-odd value -- a defensive double `agent_start` with no intervening
                    // settle -- wrongly making a still-in-flight reply from the turn BEFORE this
                    // one look like a full later settle had already happened). This starts a
                    // fresh turn: `on_session_settled`'s own `get_state` round trip runs on a
                    // spawned task (see `handle_turn_settled`), so its reply can land after this
                    // point -- `sync_from_state`'s own staleness check only drops it once a FULL
                    // LATER settle has also happened, not merely because a newer turn started.
                    if state.turn_generation % 2 == 0 {
                        state.turn_generation = state.turn_generation.wrapping_add(1);
                    }
                }
                self.set_status(SessionStatus::Working, None, None).await;
            }
            "session_settled" => {
                self.handle_turn_settled().await;
                // Issue #937, gate round 2 fix (decided): a settled turn is the one signal
                // that is genuinely safe to retry the silent attach/resume probe on -- see
                // `session::advisor`'s own header for why `on_launch` alone cannot tell "a
                // prompt is in flight" from "truly idle".
                crate::session::advisor::on_turn_settled(self).await;
            }
            "prompt_result" => {
                self.apply_transcript_frame(&frame).await;
                if frame.get("sessionSettled").and_then(Value::as_bool) == Some(true) {
                    self.handle_turn_settled().await;
                    crate::session::advisor::on_turn_settled(self).await;
                }
            }
            "queue_update" => {
                let follow_up = string_array(frame.get("followUp"));
                let steering = string_array(frame.get("steering"));
                self.set_queue(follow_up, steering).await;
            }
            "available_commands_update" => {
                let raw = frame
                    .get("commands")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let filtered = filter_supported_commands(&raw);
                {
                    let mut state = self.state.lock().await;
                    state.commands = filtered.clone();
                }
                let commands_value = Value::Array(filtered);
                self.events
                    .emit_commands_update(&self.session_id, &commands_value);
            }
            "extension_ui_request" => self.handle_extension_ui_request(&frame).await,
            "message_start" | "message_update" | "message_end" => {
                self.apply_transcript_frame(&frame).await;
            }
            // Issue #937, gate round 1 fix: `session::advisor`'s own `handle_command_output`
            // decides in one pass whether this frame is a silent probe reply to swallow (never
            // reaching the transcript) or an authoritative `/advisor on|off` toggle to track on
            // the way to rendering normally -- every OTHER `command_output` (`/usage show`,
            // `/session info`, ...) renders exactly as before #937.
            "command_output" => {
                if !crate::session::advisor::handle_command_output(self, &frame).await {
                    self.apply_transcript_frame(&frame).await;
                }
            }
            "notice" => {
                // Side-chat (`btw-history`) notices are out of scope (see this file's header);
                // every other notice goes into the main transcript.
                if frame.get("source").and_then(Value::as_str) != Some("btw-history") {
                    self.apply_transcript_frame(&frame).await;
                }
            }
            "tool_execution_start" | "tool_execution_end" => {
                self.apply_transcript_frame(&frame).await;
            }
            // `tool_execution_update` has no live-transcript effect in this build (perf/code-
            // review finding, 2026-10-13): TS only acts on it for a `task` tool's streamed
            // progress (SessionAgent.ts:1555-1558), and subagents are not ported here (see this
            // file's own header). Routing it into `apply_transcript_frame` anyway paid a lock
            // acquisition plus a transcript diff on every streamed tool-output chunk for no
            // effect; falls to the default no-op arm below instead.
            // `agent_end`, `btw_delta`/`btw_record` (side chat), and anything else: no-op, same
            // as `SessionAgent.ts`'s own default branch minus the subagent-IRC-message handling
            // this slice does not port.
            _ => {}
        }

        // Issue #784 ("Pre-declare per-lane Rust files"): the one extension point for every
        // not-yet-landed lane's frame handling, so each lane adds behaviour inside its own file
        // only and this match above never changes shape again for that lane's sake. Each
        // `on_frame` is a no-op today (cheap, allocation-free); `frame` is shared by reference so
        // no lane clones it just to decline the frame.
        crate::session::model::on_frame(self, frame_type, &frame).await;
        crate::session::readout::on_frame(self, frame_type, &frame).await;
        crate::session::side_chat::on_frame(self, frame_type, &frame).await;
        crate::session::start_queue::on_frame(self, frame_type, &frame).await;
        crate::session::subagents::on_frame(self, frame_type, &frame).await;
        crate::session::termination::on_frame(self, frame_type, &frame).await;
    }

    async fn set_queue(&self, follow_up: Vec<String>, steering: Vec<String>) {
        {
            let mut state = self.state.lock().await;
            state.queue_follow_up = follow_up.clone();
            state.queue_steering = steering.clone();
        }
        self.events
            .emit_queue_update(&self.session_id, &follow_up, &steering);
    }

    async fn handle_extension_ui_request(&self, frame: &Value) {
        match classify_dialog(frame) {
            DialogClassification::Ignore => {}
            DialogClassification::Notify { message, level } => {
                self.append_notice(message, &level).await
            }
            DialogClassification::Cancel(target) => {
                let (became_working, cancelled_request) = {
                    let mut state = self.state.lock().await;
                    let Some(cancelled_request) = state
                        .pending
                        .iter()
                        .find(|r| r.request_id() == target)
                        .cloned()
                    else {
                        return;
                    };
                    state.pending.retain(|r| r.request_id() != target);
                    (
                        state.pending.is_empty() && state.status == SessionStatus::NeedsYou,
                        cancelled_request,
                    )
                };
                self.upsert_request_row(&target, Some(RequestResolution::Cancelled))
                    .await;
                // D17 (#572): an `Ask` card closes WITHOUT this notice -- after a timeout it
                // would be untrue, since the answer summary is built from the tool result
                // instead. Every other pending-request kind keeps it exactly as before.
                if !matches!(cancelled_request, PendingRequest::Ask { .. }) {
                    self.append_notice(
                        "Request withdrawn: the agent cancelled it.".to_string(),
                        "info",
                    )
                    .await;
                }
                self.events.emit_request_resolved(&self.session_id, &target);
                if became_working {
                    self.set_status(SessionStatus::Working, None, None).await;
                }
            }
            DialogClassification::Malformed { id } => {
                // D3 (#572): no `PendingRequest` was ever created for this frame, so Refract
                // answers `{cancelled:true}` on the wire itself (instead of via
                // `answer_request`, which requires an existing pending row) and surfaces the
                // error notice in its place.
                let proc = self.state.lock().await.process.clone();
                if let Some(proc) = proc {
                    let _ = proc
                        .send_raw(
                            json!({ "type": "extension_ui_response", "id": id, "cancelled": true }),
                        )
                        .await;
                }
                self.append_notice("Couldn't show the agent's question.".to_string(), "error")
                    .await;
            }
            DialogClassification::Request(request) => {
                // Port of `addPendingRequest` (SessionAgent.ts:1641-1644): push+`NeedsYou`+
                // transcript row+`request:pending` emit all happen inside `push_pending_request`
                // (`mod.rs`) so a lane can register its own pending request the same way, in one
                // call (code-review finding, 2026-10-14: this arm used to duplicate the row
                // upsert and event emit instead of calling the accessor).
                self.push_pending_request(request).await;
            }
        }
    }

    /// Runs the turn-end settle sequence at most once per turn (port of `SessionAgent.ts`'s own
    /// `handleTurnSettled`): resolves any still-pending requests, moves to `idle`, then
    /// re-syncs from a fresh `get_state`.
    async fn handle_turn_settled(&self) {
        let (generation, shutdown_generation) = {
            let mut state = self.state.lock().await;
            // Even `turn_generation` means this turn is already settled (see the `agent_start`
            // arm's own doc comment for the odd/even encoding) -- a duplicate `session_settled`/
            // `prompt_result.sessionSettled` frame for the same turn, so this is a no-op.
            if state.turn_generation % 2 == 0 {
                return;
            }
            state.turn_generation = state.turn_generation.wrapping_add(1);
            // Issue #911: this turn (whichever one it was) has now fully settled -- every
            // `tool_execution_end` it will ever receive has already been applied (frames are
            // handled strictly in arrival order, one at a time; a prompt_result/session_settled
            // frame is always the LAST frame of its own turn). Safe to clear unconditionally:
            // a no-op on a turn `stop()` was never called for (the flag was already false).
            state.turn_abort_requested = false;
            (state.turn_generation, state.shutdown_generation)
        };
        self.settle_turn_pending().await;
        self.set_status(SessionStatus::Idle, None, None).await;
        // Gate-fix (#856): `on_session_settled`'s own `get_state` round trip (up to
        // `DEFAULT_REQUEST_TIMEOUT_MS`, 60s) used to run inline here, on the SAME task that
        // `spawn_frame_listener`'s own `rx.recv()` loop calls `handle_frame` from -- nothing
        // read another frame (including the NEXT turn's own `agent_start`) until it returned.
        // Spawned instead, tagged with this turn's `turn_generation` and `shutdown_generation`:
        // `sync_from_state` re-checks both (see its own doc comment) before applying anything,
        // so a reply landing after a NEWER SETTLE (not merely a newer turn starting) or a
        // stop/restart is dropped rather than clobbering fresher state.
        let agent = self.arc();
        tokio::spawn(async move {
            agent
                .on_session_settled(generation, shutdown_generation)
                .await
        });
    }

    /// Port of `SessionAgent.ts`'s own `settleTurnPendingRequests`: every still-pending request
    /// is resolved `cancelled` (constitution II: every request must be answered or settled).
    async fn settle_turn_pending(&self) {
        let ids: Vec<String> = {
            let mut state = self.state.lock().await;
            let ids: Vec<String> = state
                .pending
                .iter()
                .map(|r| r.request_id().to_string())
                .collect();
            state.pending.clear();
            ids
        };
        for id in ids {
            self.upsert_request_row(&id, Some(RequestResolution::Cancelled))
                .await;
            self.events.emit_request_resolved(&self.session_id, &id);
        }
    }

    async fn on_session_settled(&self, generation: u64, shutdown_generation: u64) {
        let proc = { self.state.lock().await.process.clone() };
        let Some(proc) = proc else { return };
        if let Ok(res) = proc
            .request(json!({ "type": "get_state" }), DEFAULT_REQUEST_TIMEOUT_MS)
            .await
        {
            if res.get("success").and_then(Value::as_bool) == Some(true) {
                if let Some(data) = res.get("data") {
                    self.sync_from_state(data, Some((generation, shutdown_generation)))
                        .await;
                }
            }
        }
    }

    /// `launch.rs`'s own `sync_from_state` staleness guard, factored out so it can be re-checked
    /// BOTH at entry and again immediately before that function's own registry write (round 2
    /// MEDIUM/security finding: a settle-time reply or a Conversation reset could otherwise land
    /// in the gap between the entry check and the write, which is awaited behind its own
    /// `registry`/`readout` locks) without duplicating this 6-line check at both call sites.
    /// `None` (every OTHER `sync_from_state` caller) is never stale.
    pub(super) async fn settle_is_stale(&self, stale_if: Option<(u64, u64)>) -> bool {
        let Some((generation, shutdown_generation)) = stale_if else {
            return false;
        };
        let s = self.state.lock().await;
        s.turn_generation.wrapping_sub(generation) >= 2
            || s.shutdown_generation != shutdown_generation
    }

    /// Port of `SessionAgent.ts`'s own `onExit`. The epoch guard (`proc` must still be
    /// `state.process`) is a real port, not a no-op (code-review finding, 2026-10-13: this
    /// file's header previously said the TS guard only protects a `restart()` this build does
    /// not implement -- that was wrong; `SessionAgent.ts:1440-1449` says it guards exactly this
    /// `launch()` race, where the listener task's own `Exit` can arrive after a quick
    /// stop-then-start already moved `state.process` on to a newer life).
    /// `detectUnexpectedTermination`'s crash-tail read and the persisted stopped-on-request
    /// marker are computed by `session::termination`'s own `on_exit` hook, called right after
    /// this function returns (`agent::launch`'s own `spawn_frame_listener`), not here -- the
    /// fourth returned value is `termination::State::epoch` as read in THIS call's own lock
    /// acquisition, threaded through as that hook's `epoch_at_exit` parameter.
    pub(super) async fn handle_exit(
        &self,
        proc: &Arc<OmpProcess>,
        code: Option<i32>,
        requested: bool,
    ) -> (bool, bool, bool, u64) {
        let (is_current, stop_requested, was_already_stopped, epoch_at_exit, exited_pid) = {
            let mut state = self.state.lock().await;
            let is_current = state.process.as_ref().map(Arc::as_ptr) == Some(Arc::as_ptr(proc));
            let was_already_stopped = state.status == SessionStatus::Stopped;
            if is_current {
                state.process = None;
            }
            (
                is_current,
                state.stop_requested,
                was_already_stopped,
                // Gate-fix (code review MEDIUM, round 6): captured in this SAME lock acquisition
                // -- see `termination::State::epoch`'s own doc comment for why a separate,
                // later read left a race window open.
                state.termination.epoch,
                proc.pid(),
            )
        };
        if is_current {
            // Lane R3 (issue #786, #656): the pid-record fallback for orphan reaping. Awaited
            // here (not fire-and-forget, gate-fix: perf/correctness review) so this write is
            // strictly ordered after the matching `record_process` write in `launch()` --
            // otherwise two independently-spawned tasks racing on the same `pid` have no
            // guaranteed ordering, and a very-short-lived process could have its "exited" write
            // land before its own "spawned" write, leaving a phantom orphan record behind.
            if let Some(pid) = exited_pid {
                crate::process::pid_records::remove_process_record(pid).await;
            }
        }
        if !is_current {
            return (false, stop_requested, was_already_stopped, epoch_at_exit);
        }
        // Finalizes every still-live row before settling pending requests (code-review finding,
        // 2026-10-13: TS calls `finalizeLiveItems` first, `SessionAgent.ts:1379`); otherwise a
        // crash or `stop()` mid-turn leaves a streaming/running row spinning forever. `cause` is
        // decided from the SAME `requested`/`stop_requested` already captured above (#563
        // decision 15): `requested && stop_requested` is this call's own branch below for "the
        // user asked this session to stop" (`set_status(Stopped, ...)`); anything else -- a
        // genuine crash, or `launch()`'s internal handshake-cleanup stop, which is not a user
        // request either -- settles a still-running Subagent row to `Exited`, not `Cancelled`.
        let finalize_cause = if requested && stop_requested {
            SubagentFinalizeCause::UserStop
        } else {
            SubagentFinalizeCause::Crash
        };
        {
            let mut state = self.state.lock().await;
            let before = state.transcript.items().to_vec();
            state.transcript.finalize_live_items(finalize_cause);
            let ops = diff_transcript(&before, state.transcript.items());
            if !ops.is_empty() {
                self.coalescer.queue(ops);
            }
        }
        self.settle_turn_pending().await;
        if requested {
            if !stop_requested {
                // A `launch()`-internal cleanup stop (failed handshake/attach), never the user
                // asking to stop -- `launch()`'s own catch paths already recorded the real
                // stopped/start-failed status for this; nothing further to do here.
                return (
                    is_current,
                    stop_requested,
                    was_already_stopped,
                    epoch_at_exit,
                );
            }
            self.set_status(SessionStatus::Stopped, Some("not-started"), None)
                .await;
            return (
                is_current,
                stop_requested,
                was_already_stopped,
                epoch_at_exit,
            );
        }
        let detail = match code {
            Some(c) => format!("exit code {c}"),
            None => "exit code null".to_string(),
        };
        self.set_stopped_unless_already_stopped("agent-exited", Some(detail))
            .await;
        (
            is_current,
            stop_requested,
            was_already_stopped,
            epoch_at_exit,
        )
    }
}
