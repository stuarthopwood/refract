// Live frame handling: the frame match, turn settle, and process-exit handling.

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
                    // Parity counter: odd is mid-turn, even is settled. Bumped only from even.
                    // A settle reply landing after this turn starts is dropped by sync_from_state.
                    if state.turn_generation % 2 == 0 {
                        state.turn_generation = state.turn_generation.wrapping_add(1);
                    }
                    // Every new turn starts clean, including a queued follow-up after a stop. (#911)
                    state.turn_abort_requested = false;
                }
                self.set_status(SessionStatus::Working, None, None).await;
            }
            "session_settled" => {
                self.handle_turn_settled().await;
                // A settled turn is the only safe point to retry the silent attach/resume probe. (#937)
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
                // After the store write, so a waiter that wakes reads this life's own list.
                self.commands_reported.notify_waiters();
                let commands_value = Value::Array(filtered);
                self.events
                    .emit_commands_update(&self.session_id, &commands_value);
                // Kept for Sessions that have not started. An empty report would erase a usable list;
                // the native entries `filtered` always carries do not make it usable. (#1812)
                // After the emit, so the fsync never delays the UI event.
                if let (false, Value::Array(list)) = (raw.is_empty(), &commands_value) {
                    crate::store::last_commands::save(list).await;
                }
            }
            "extension_ui_request" => self.handle_extension_ui_request(&frame).await,
            "message_start" | "message_update" | "message_end" => {
                self.apply_transcript_frame(&frame).await;
            }
            // The advisor module decides whether a command_output is a silent probe reply to swallow. (#937)
            "command_output" => {
                if !crate::session::advisor::handle_command_output(self, &frame).await
                    && !crate::session::token_guard::swallow_shake_output(self, &frame).await
                {
                    self.apply_transcript_frame(&frame).await;
                }
            }
            "notice" => {
                // Side-chat notices stay out of the main transcript.
                if frame.get("source").and_then(Value::as_str) != Some("btw-history") {
                    self.apply_transcript_frame(&frame).await;
                }
            }
            "tool_execution_start" | "tool_execution_end" => {
                self.apply_transcript_frame(&frame).await;
            }
            "host_tool_call" => self.agent_tools.handle_call(&self.arc(), &frame),
            "host_tool_cancel" => self.agent_tools.handle_cancel(&frame),
            "subagent_lifecycle" => {
                if let Some(payload) = frame.get("payload") {
                    self.on_subagent_started(payload).await;
                }
            }
            // tool_execution_update is ignored: only subagent progress uses it, and that is not ported.
            // Other frames, including agent_end and side-chat deltas, are no-ops here.
            _ => {}
        }

        // Extension point for lanes not yet landed. Each on_frame is a cheap no-op today.
        crate::session::model::on_frame(self, frame_type, &frame).await;
        crate::session::prewalk::on_frame(self, frame_type, &frame).await;
        crate::session::readout::on_frame(self, frame_type, &frame).await;
        crate::session::side_chat::on_frame(self, frame_type, &frame).await;
        crate::session::start_queue::on_frame(self, frame_type, &frame).await;
        crate::session::subagents::on_frame(self, frame_type, &frame).await;
        crate::session::termination::on_frame(self, frame_type, &frame).await;
        crate::session::token_guard::on_frame(self, frame_type, &frame).await;
        crate::session::usage_nudge::on_frame(self, frame_type, &frame).await;
    }

    async fn set_queue(&self, follow_up: Vec<String>, steering: Vec<String>) {
        let (follow_up, steering) = {
            let mut state = self.state.lock().await;
            state.queue_follow_up = follow_up;
            state.queue_steering = steering;
            super::pause::queue_view(&state, &state.queue_follow_up, &state.queue_steering)
        };
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
                // Ask cards close without this notice, since their answer summary comes from the tool result. (#572)
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
                // No PendingRequest exists for this frame, so reply cancelled on the wire directly. (#572)
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
                // push_pending_request handles the row, NeedsYou, and the emit in one call.
                self.push_pending_request(request.clone()).await;
                crate::session::working_mode::away::on_request(self, request).await;
            }
        }
    }

    /// Runs the turn-end settle once per turn: resolves pending requests, goes idle, then re-syncs.
    async fn handle_turn_settled(&self) {
        let (generation, shutdown_generation) = {
            let mut state = self.state.lock().await;
            // Already settled for this turn, so a duplicate settle frame is a no-op.
            if state.turn_generation % 2 == 0 {
                return;
            }
            state.turn_generation = state.turn_generation.wrapping_add(1);
            // Clears the abort flag for this turn. A no-op if stop() was never called for it. (#911)
            state.turn_abort_requested = false;
            (state.turn_generation, state.shutdown_generation)
        };
        self.settle_turn_pending().await;
        self.set_status(SessionStatus::Idle, None, None).await;
        crate::session::token_guard::on_turn_settled(self, generation).await;
        crate::session::working_mode::on_turn_settled(self).await;
        // Spawned so the get_state round trip does not block the frame loop. Tagged with generation counters.
        // sync_from_state re-checks both counters before writing, so stale replies are dropped.
        let agent = self.arc();
        tokio::spawn(async move {
            agent
                .on_session_settled(generation, shutdown_generation)
                .await
        });
    }

    /// Resolves every still-pending request as cancelled, so none is left unanswered.
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

    /// Staleness guard for sync_from_state, checked at entry and again before its registry write.
    /// None (other callers) is never stale.
    pub(super) async fn settle_is_stale(&self, stale_if: Option<(u64, u64)>) -> bool {
        let Some((generation, shutdown_generation)) = stale_if else {
            return false;
        };
        let s = self.state.lock().await;
        s.turn_generation.wrapping_sub(generation) >= 2
            || s.shutdown_generation != shutdown_generation
    }

    /// Handles process exit. The epoch guard stops a late Exit from a previous life from applying.
    /// The crash-tail read and stopped marker run in termination's on_exit hook, after this returns.
    pub(super) async fn handle_exit(
        &self,
        proc: &Arc<OmpProcess>,
        code: Option<i32>,
        requested: bool,
    ) -> (bool, bool, bool, u64) {
        let (
            is_current,
            stop_requested,
            was_already_stopped,
            epoch_at_exit,
            exited_pid,
            turn_abort_requested,
        ) = {
            let mut state = self.state.lock().await;
            let is_current = state.process.as_ref().map(Arc::as_ptr) == Some(Arc::as_ptr(proc));
            let was_already_stopped = state.status == SessionStatus::Stopped;
            let turn_abort_requested = state.turn_abort_requested;
            if is_current {
                state.process = None;
                // Clears the abort flag so it cannot leak into a later launch. (#911)
                state.turn_abort_requested = false;
                // Cancelled ids name subagents of the dead process; a later Resume must not report them.
                state.pause.cancelled.clear();
            }
            (
                is_current,
                state.stop_requested,
                was_already_stopped,
                // Epoch is read in this same lock, so a racing stop cannot slip between reads.
                state.termination.epoch,
                proc.pid(),
                turn_abort_requested,
            )
        };
        if is_current {
            self.agent_tools.drop_all();
            // Awaited so this write lands after the matching spawn record, avoiding a phantom orphan.
            if let Some(pid) = exited_pid {
                crate::process::pid_records::remove_process_record(pid).await;
            }
        }
        if !is_current {
            return (false, stop_requested, was_already_stopped, epoch_at_exit);
        }
        // Finalizes live rows before settling requests, so a crash or stop mid-turn leaves no spinners.
        // A user stop, requested or via the turn abort, settles Cancelled. Any other exit settles Exited or Error.
        let finalize_cause = if (requested && stop_requested) || turn_abort_requested {
            SubagentFinalizeCause::UserStop
        } else {
            SubagentFinalizeCause::Crash
        };
        {
            let mut state = self.state.lock().await;
            let before = state.transcript.snapshot();
            state.transcript.finalize_live_items(finalize_cause);
            let ops = diff_transcript(&before, state.transcript.items());
            if !ops.is_empty() {
                self.coalescer.queue(ops);
            }
        }
        self.settle_turn_pending().await;
        if requested {
            if !stop_requested {
                // A launch-internal cleanup stop; launch already recorded the real status.
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
