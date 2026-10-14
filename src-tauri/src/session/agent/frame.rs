// Live frames (port of `SessionAgent.ts`'s own `onFrame`): the listener loop, the one frame-type
// match (including the per-lane `on_frame` extension-point calls right after it), queue/commands
// updates, pending-request dialog routing, turn-settle, and process-exit handling. See `mod.rs`'s
// own header for this module's place in the `agent/` split and the lane extension contract.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::omp::diff::diff_transcript;
use crate::omp::process::OmpProcess;
use crate::omp::transcript::RequestResolution;

use super::commands::{filter_supported_commands, string_array};
use super::requests::{classify_dialog, DialogClassification};
use super::{SessionAgent, SessionStatus, DEFAULT_REQUEST_TIMEOUT_MS};

impl SessionAgent {
    pub(super) async fn handle_frame(&self, frame: Value) {
        let frame_type = frame.get("type").and_then(Value::as_str).unwrap_or("");
        match frame_type {
            "agent_start" => {
                {
                    let mut state = self.state.lock().await;
                    state.turn_settle_handled = false;
                }
                self.set_status(SessionStatus::Working, None, None).await;
            }
            "session_settled" => self.handle_turn_settled().await,
            "prompt_result" => {
                self.apply_transcript_frame(&frame).await;
                if frame.get("sessionSettled").and_then(Value::as_bool) == Some(true) {
                    self.handle_turn_settled().await;
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
            "message_start" | "message_update" | "message_end" | "command_output" => {
                self.apply_transcript_frame(&frame).await;
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
                let became_working = {
                    let mut state = self.state.lock().await;
                    if !state.pending.iter().any(|r| r.request_id() == target) {
                        return;
                    }
                    state.pending.retain(|r| r.request_id() != target);
                    state.pending.is_empty() && state.status == SessionStatus::NeedsYou
                };
                self.upsert_request_row(&target, Some(RequestResolution::Cancelled))
                    .await;
                self.append_notice(
                    "Request withdrawn: the agent cancelled it.".to_string(),
                    "info",
                )
                .await;
                self.events.emit_request_resolved(&self.session_id, &target);
                if became_working {
                    self.set_status(SessionStatus::Working, None, None).await;
                }
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
        {
            let mut state = self.state.lock().await;
            if state.turn_settle_handled {
                return;
            }
            state.turn_settle_handled = true;
        }
        self.settle_turn_pending().await;
        self.set_status(SessionStatus::Idle, None, None).await;
        self.on_session_settled().await;
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

    async fn on_session_settled(&self) {
        let proc = { self.state.lock().await.process.clone() };
        let Some(proc) = proc else { return };
        if let Ok(res) = proc
            .request(json!({ "type": "get_state" }), DEFAULT_REQUEST_TIMEOUT_MS)
            .await
        {
            if res.get("success").and_then(Value::as_bool) == Some(true) {
                if let Some(data) = res.get("data") {
                    self.sync_from_state(data).await;
                }
            }
        }
    }

    /// Port of `SessionAgent.ts`'s own `onExit`. The epoch guard (`proc` must still be
    /// `state.process`) is a real port, not a no-op (code-review finding, 2026-10-13: this
    /// file's header previously said the TS guard only protects a `restart()` this build does
    /// not implement -- that was wrong; `SessionAgent.ts:1440-1449` says it guards exactly this
    /// `launch()` race, where the listener task's own `Exit` can arrive after a quick
    /// stop-then-start already moved `state.process` on to a newer life).
    /// `detectUnexpectedTermination`'s crash-tail read and the persisted stopped-on-request
    /// marker are computed by `session::termination`'s own `on_exit` hook, called right after
    /// this function returns (`agent::launch`'s own `spawn_frame_listener`), not here.
    pub(super) async fn handle_exit(
        &self,
        proc: &Arc<OmpProcess>,
        code: Option<i32>,
        requested: bool,
    ) -> (bool, bool) {
        let (is_current, stop_requested, exited_pid) = {
            let mut state = self.state.lock().await;
            let is_current = state.process.as_ref().map(Arc::as_ptr) == Some(Arc::as_ptr(proc));
            if is_current {
                state.process = None;
            }
            (is_current, state.stop_requested, proc.pid())
        };
        if is_current {
            // Lane R3 (issue #786, #515): the pid-record fallback for orphan reaping. Awaited
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
            return (false, stop_requested);
        }
        // Finalizes every still-live row before settling pending requests (code-review finding,
        // 2026-10-13: TS calls `finalizeLiveItems` first, `SessionAgent.ts:1379`); otherwise a
        // crash or `stop()` mid-turn leaves a streaming/running row spinning forever.
        {
            let mut state = self.state.lock().await;
            let before = state.transcript.items().to_vec();
            state.transcript.finalize_live_items();
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
                return (is_current, stop_requested);
            }
            self.set_status(SessionStatus::Stopped, Some("not-started"), None)
                .await;
            return (is_current, stop_requested);
        }
        let detail = match code {
            Some(c) => format!("exit code {c}"),
            None => "exit code null".to_string(),
        };
        self.set_stopped_unless_already_stopped("agent-exited", Some(detail))
            .await;
        (is_current, stop_requested)
    }
}
