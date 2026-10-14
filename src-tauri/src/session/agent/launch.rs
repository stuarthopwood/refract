// Start / reattach (port of `SessionAgent.ts`'s `start`/`doStart`/`launch`/`attachAndVerify`).
// The free functions this flow needs (`reattachVerification.ts`'s `verifyReattach`,
// `fetchAllMessages.ts`) live in the sibling `launch_support.rs` (split out round 4, 2026-10-14,
// issue #806 600-line cap). See `mod.rs`'s own header for this module's place in the `agent/`
// split and the lane extension contract.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};

use crate::git::worktree_validity::{worktree_is_valid, WorktreeValidity};
use crate::omp::process::{OmpProcess, OmpProcessOptions, ProcessEvent};
use crate::store::registry::{Session, SessionPatch};

use super::launch_support::{
    assert_conversation_file_exists, fetch_all_messages, reattach_rebaseline_notice,
    registry_store_error_message, to_process_mode, truncate, verify_reattach,
};
use super::{
    AgentError, SessionAgent, SessionStatus, DEFAULT_REQUEST_TIMEOUT_MS, MAX_MODEL_FIELD_LENGTH,
};

impl SessionAgent {
    /// Gate-fix (round 5, HIGH): a queued start could win the `start_lock` race against a
    /// concurrent `shutdown()`, reset `stop_requested` to `false`, and finish `Idle` --
    /// `shutdown()`'s own later `proc_after.stop()` then force-kills it as an unrequested exit.
    /// `generation_at_entry` (snapshotted BEFORE `start_lock`) catches a `shutdown()` bump.
    async fn bail_if_shutdown_raced(&self, generation_at_entry: u64) -> Result<(), AgentError> {
        if self.state.lock().await.shutdown_generation != generation_at_entry {
            self.mark_stopped_not_started().await;
            return Err(AgentError::new(
                "not-started",
                "SessionAgent: start cancelled",
            ));
        }
        Ok(())
    }

    /// `sessions.open`'s auto-start path and the initial `start()` call alike. Joins an
    /// already-live process as a no-op (simplified "join the in-flight attempt" behaviour: the
    /// TS original shares the exact in-flight `Promise`; this serialises instead through
    /// `start_lock`, which gives the same externally-visible result for every caller here).
    pub async fn start(&self) -> Result<(), AgentError> {
        // Snapshotted BEFORE `start_lock` is requested -- see `bail_if_shutdown_raced`.
        let generation_at_entry = self.state.lock().await.shutdown_generation;
        let _guard = self.start_lock.lock().await;
        self.bail_if_shutdown_raced(generation_at_entry).await?;
        {
            let state = self.state.lock().await;
            if state.process.is_some() {
                return Ok(());
            }
        }
        {
            let mut state = self.state.lock().await;
            state.stop_requested = false;
        }
        let session = self.require_session().await?;
        // Lane R3 (issue #786), once R2 (#826) landed `worktree_is_valid`: replaces the plain
        // `fs::metadata` existence check -- catches a worktree whose `.git` pointer was hand-
        // deleted or that git no longer has registered, not merely "the folder is gone" (#729).
        // `Unknown` (the underlying `git worktree list` call could not be made to settle within
        // its own timeout) must never block a start -- a slow disk/antivirus scan is not
        // evidence the worktree is actually missing, so this agent starts normally the same as
        // `Valid` (matching `session::manager::summaries()`'s own documented `Unknown` policy).
        let repo_path = {
            let registry = self.registry.lock().await;
            registry
                .get_repository(&session.repository_id)
                .map(|r| r.path.clone())
        };
        let validity = match repo_path {
            Some(path) => {
                worktree_is_valid(Path::new(&path), Path::new(&session.worktree_path)).await
            }
            None => WorktreeValidity::Invalid,
        };
        if validity == WorktreeValidity::Invalid {
            self.set_status(
                SessionStatus::Stopped,
                Some("worktree-missing"),
                Some(session.worktree_path.clone()),
            )
            .await;
            return Err(AgentError::new(
                "worktree-missing",
                format!("Worktree missing: {}", session.worktree_path),
            ));
        }
        self.launch(&session, "").await
    }

    /// Port of `conversationSwitch.ts`'s own `startStoppedSessionOnConversation`: writes the
    /// chosen Conversation (`file`, or `None` for a brand-new one) into the registry INSIDE the
    /// same `start_lock`-guarded attempt `start()` uses, before `launch()` reads the Session
    /// back -- so a start already in flight, or a live process, refuses outright instead of
    /// silently reattaching the OLD Conversation.
    pub async fn start_with_conversation(&self, file: Option<String>) -> Result<(), AgentError> {
        let generation_at_entry = self.state.lock().await.shutdown_generation;
        let _guard = self.start_lock.lock().await;
        self.bail_if_shutdown_raced(generation_at_entry).await?;
        {
            let state = self.state.lock().await;
            if state.process.is_some() || state.status != SessionStatus::Stopped {
                return Err(AgentError::new(
                    "not-idle",
                    format!(
                        "SessionAgent {}: cannot start while not idle",
                        self.session_id
                    ),
                ));
            }
        }
        {
            let mut state = self.state.lock().await;
            state.stop_requested = false;
        }
        let session = self.require_session().await?;
        if tokio::fs::metadata(&session.worktree_path).await.is_ok() {
            let patch = SessionPatch {
                current_conversation: Some(file),
                last_message_count: Some(None),
                ..Default::default()
            };
            self.registry
                .lock()
                .await
                .update_session(&self.session_id, patch)
                .await
                .map_err(|err| AgentError::new("git-failed", registry_store_error_message(err)))?;
        }
        let session = self.require_session().await?;
        self.launch(&session, "").await
    }

    pub(super) async fn launch(
        &self,
        session: &Session,
        failure_prefix: &str,
    ) -> Result<(), AgentError> {
        // Lane R3 (issue #786): a new life starting means whatever the PREVIOUS life's
        // requested stop protected no longer applies to THIS one (`stoppedOnRequestMarker.ts`'s
        // own `clearStoppedOnRequestMarker`, called at the top of every `launch()` attempt).
        self.clear_stopped_on_request_marker().await;

        let approval_mode = self.settings.lock().await.get().approval_mode;
        let opts = OmpProcessOptions::new(
            PathBuf::from(&session.worktree_path),
            to_process_mode(approval_mode),
        );

        // Lane R3 (issue #786, "one hook" this lane adds to core `agent.rs`): the process-wide
        // start-slot gate and low-memory defer (`startQueue.ts`'s own `acquireStartSlot`/
        // `deferStartIfMemoryLow`).
        let slot_guard = crate::session::start_queue::acquire_slot(self).await?;
        // Gate-fix (code review HIGH, round 2): covers the WHOLE rest of this attempt (every
        // return path below, success included -- `clear_stage` is idempotent) so a start that
        // fails during `wait_ready` (ceiling, or the process exiting before ready) can never
        // leave its `waiting`/`prompt` stage stuck on the wire the way a success-only clear did.
        let _stage_guard = crate::session::start_queue::guard_stage_for_attempt(self);

        let proc = match OmpProcess::connect(&opts).await {
            Ok(p) => p,
            Err(err) => {
                let detail = format!("{failure_prefix}{}", err.message);
                self.record_start_failure(&detail).await;
                return Err(AgentError::new("start-failed", detail));
            }
        };
        let proc = Arc::new(proc);
        // Lane R3 (issue #786): `startQueue.ts`'s own `markSpawned`/`unmarkSpawned` pairing (the
        // narrower "has a process actually spawned" count the memory defer above checks), and
        // `pidRecords.ts`'s own orphan-reaping fallback record. Awaited (gate-fix, perf/
        // correctness review): strictly orders this write before any later `remove_process_
        // record` for the same pid (`handle_exit`) could possibly run, and a JSON write here is
        // cheap next to the ready-wait this attempt is about to pay regardless.
        let spawned_guard = crate::session::start_queue::mark_spawned();
        if let Some(pid) = proc.pid() {
            crate::process::pid_records::record_process(pid, &self.session_id).await;
        }
        // Subscribed before `wait_ready` (code-review/perf finding, 2026-10-13): registers this
        // listener before any frame -- including ones the ready-wait itself observes -- can
        // possibly be produced, the same guarantee `OmpProcess.ts` gets from attaching
        // `proc.on('frame', ...)` before calling `start()` (SessionAgent.ts:471).
        self.spawn_frame_listener(proc.clone(), proc.subscribe());
        // Lane R3 (issue #786, #656): a cancel landing from here on must stop the now-spawned
        // process, not just abandon the wait -- `acquire_slot`'s own cancel check above only
        // covers the queued/memory-deferred phase, before any process existed to leak.
        let cancel_watch = crate::session::start_queue::watch_for_cancel(self, proc.clone()).await;
        let wait_result = proc.wait_ready(&opts).await;
        // Gate-fix (code review MEDIUM, round 3): both released right here, matching TS's own
        // `OmpProcess.start()` scope (`acquireStartSlot`/`markSpawned` are process-level, never
        // held across the Session-level reattach/history-fetch below) -- held any longer, a
        // Cancel or `shutdown()` landing during `attach_and_verify`/`fetch_all_messages` would
        // still reach `watch_for_cancel`'s own handler and kill an agent that is already ready.
        drop(cancel_watch);
        drop(slot_guard);
        drop(spawned_guard);
        if let Err(err) = wait_result {
            // Gate-fix (round 4, found live via CDP): a cancel landing during this exact wait
            // (`watch_for_cancel`'s own handler above) already recorded a clean cancelled status
            // via `end_cancelled_attempt` -- that handler's own `proc.stop()` call is what makes
            // THIS `wait_ready` call return the error being matched here in the first place, so
            // without this check every cancelled start ended up on the raw, generic
            // "OmpProcess: process exited before ready" failure banner (Retry/Start new
            // conversation) a moment later, clobbering the correct one. See
            // `start_queue::State::cancel_already_recorded`'s own doc comment for the exact
            // ordering guarantee that makes this check race-free.
            if crate::session::start_queue::take_cancel_already_recorded(self).await {
                return Err(AgentError::new(
                    "not-started",
                    "SessionAgent: start cancelled",
                ));
            }
            let detail = format!("{failure_prefix}{}", err.message);
            self.record_start_failure(&detail).await;
            return Err(AgentError::new("start-failed", detail));
        }
        // Lane R3 (issue #786, gate-fix): the ready frame arrived -- any lingering `waiting`/
        // `prompt`/`extended` stage must disappear from the wire right now, not linger until the
        // next unrelated status event happens to clear it (TS's own `OmpProcess.ts` calls
        // `setStartProgress(undefined)` at this exact point too).
        crate::session::start_queue::clear_stage_on_ready(self).await;

        if self.state.lock().await.stop_requested {
            proc.stop().await;
            self.set_status(SessionStatus::Stopped, Some("not-started"), None)
                .await;
            return Err(AgentError::new(
                "not-started",
                "SessionAgent: stop requested during launch",
            ));
        }

        {
            let mut state = self.state.lock().await;
            state.process = Some(proc.clone());
        }

        let state_data = match self.attach_and_verify(&proc, session).await {
            Ok(data) => data,
            Err(err) => {
                proc.stop().await;
                self.state.lock().await.process = None;
                // Gate-fix (round 6, FR-038, code review HIGH): a `shutdown()` (stopAgent/
                // archive/delete/app quit) racing this exact await sets `stop_requested` and
                // stops this SAME process -- exactly what makes `attach_and_verify`'s own
                // request fail here. Re-checked AFTER the `proc.stop()` above (which can itself
                // take a moment) so a deliberate stop during attach never ends start-failed
                // with an error notice; it ends stopped/not-started like every other
                // stop-during-launch branch in this function, matching TS's own `shutdown()`
                // contract (`bailIfStopRequested`).
                if self.state.lock().await.stop_requested {
                    self.mark_stopped_not_started().await;
                    return Err(AgentError::new(
                        "not-started",
                        "SessionAgent: stop requested during launch",
                    ));
                }
                let detail = format!("{failure_prefix}{err}");
                self.record_start_failure(&detail).await;
                return Err(AgentError::new("reattach-failed", detail));
            }
        };
        // Constitution v1.9.0 / FINDINGS item 44: computed from the PRE-launch `session`
        // parameter (the registry's last known `last_message_count`) vs the freshly observed
        // `state_data`, before `sync_from_state` re-baselines it below -- see
        // `reattach_rebaseline_notice`'s own doc comment.
        let rebaseline_notice = session
            .current_conversation
            .as_ref()
            .and_then(|_| reattach_rebaseline_notice(session, &state_data));

        if self.state.lock().await.stop_requested {
            proc.stop().await;
            self.state.lock().await.process = None;
            self.set_status(SessionStatus::Stopped, Some("not-started"), None)
                .await;
            return Err(AgentError::new(
                "not-started",
                "SessionAgent: stop requested during launch",
            ));
        }

        let (messages, complete) = fetch_all_messages(&proc).await;

        // Port of `exitedDuringStart`: a concurrent `onExit` may have cleared `process` while the
        // history fetch above was in flight.
        self.fail_if_process_changed(&proc, failure_prefix).await?;

        let current_mode = self.settings.lock().await.get().approval_mode;
        {
            let mut state = self.state.lock().await;
            state.status = SessionStatus::Idle;
            state.stop_reason = None;
            state.stop_detail = None;
            state.launched_mode = approval_mode;
            state.pending_mode = if current_mode == approval_mode {
                None
            } else {
                Some(current_mode)
            };
            if complete {
                // Merges in the freshly fetched history rather than replacing the transcript
                // outright (code-review finding, 2026-10-13): a flat replace silently dropped
                // any notice/request/in-flight item a live frame appended while this fetch was
                // in flight. Port of `mergeLiveTranscript`.
                state.transcript.merge_from_history(&messages);
                let _ = state.transcript.settle_interrupted_tool_rows();
            }
        }
        // Told once here (after the merge above so it isn't dropped as an unpersisted notice),
        // and BEFORE `sync_from_state` re-baselines `last_message_count` to the observed value.
        if let Some(notice) = rebaseline_notice {
            self.append_notice(notice, "info").await;
        }

        self.sync_from_state(&state_data).await;

        self.fail_if_process_changed(&proc, failure_prefix).await?;

        self.emit_status().await;
        self.emit_patch_reset().await;
        Ok(())
    }

    /// Port of `exitedDuringStart`: fails the attempt when a concurrent `on_exit` (a real crash)
    /// has cleared `state.process` out from under it while `fetch_all_messages`/`sync_from_state`
    /// were in flight -- factored out (round 6, code review HIGH) since both call sites need the
    /// SAME FR-038 re-check this got wrong before: a `shutdown()` racing this exact window also
    /// clears `process` (via the exit its own `proc.stop()` causes), which must end
    /// stopped/not-started like every other stop-during-launch branch in `launch()`, never
    /// start-failed with an error notice.
    async fn fail_if_process_changed(
        &self,
        proc: &Arc<OmpProcess>,
        failure_prefix: &str,
    ) -> Result<(), AgentError> {
        if self.state.lock().await.process.as_ref().map(Arc::as_ptr) == Some(Arc::as_ptr(proc)) {
            return Ok(());
        }
        if self.state.lock().await.stop_requested {
            self.mark_stopped_not_started().await;
            return Err(AgentError::new(
                "not-started",
                "SessionAgent: stop requested during launch",
            ));
        }
        let detail = format!("{failure_prefix}agent exited during start");
        self.record_start_failure(&detail).await;
        Err(AgentError::new("start-failed", detail))
    }

    /// Port of `SessionAgent.ts`'s own `attachAndVerify`: `switch_session` to the Session's
    /// `currentConversation` (skipped for a brand-new Session), then `get_state` plus the
    /// reattach verification (`reattachVerification.ts`'s `verifyReattach`). Throws (returns
    /// `Err`) on any failure; the caller stops `proc` and records it.
    async fn attach_and_verify(
        &self,
        proc: &OmpProcess,
        session: &Session,
    ) -> Result<Value, String> {
        if let Some(conversation) = &session.current_conversation {
            assert_conversation_file_exists(conversation).await?;
            let switch_res = proc
                .request(
                    json!({ "type": "switch_session", "sessionPath": conversation }),
                    DEFAULT_REQUEST_TIMEOUT_MS,
                )
                .await
                .map_err(|err| err.to_string())?;
            let cancelled = switch_res
                .get("data")
                .and_then(|d| d.get("cancelled"))
                .and_then(Value::as_bool);
            if switch_res.get("success").and_then(Value::as_bool) != Some(true)
                || cancelled != Some(false)
            {
                return Err(format!(
                    "switch_session failed or was cancelled for {conversation}"
                ));
            }
        }
        let state_res = proc
            .request(json!({ "type": "get_state" }), DEFAULT_REQUEST_TIMEOUT_MS)
            .await
            .map_err(|err| err.to_string())?;
        if state_res.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(format!(
                "get_state failed: {}",
                state_res
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown error")
            ));
        }
        let data = state_res.get("data").cloned().unwrap_or(Value::Null);
        if let Some(conversation) = &session.current_conversation {
            verify_reattach(conversation, &data)?;
        }
        Ok(data)
    }

    /// Runs after the initial `get_state` and after every `session_settled` (port of
    /// `SessionAgent.ts`'s own `syncFromState`): persists `sessionDir`/`currentConversation`/
    /// `lastMessageCount`/`lastModel`/`lastThinkingLevel` once `messageCount > 0`.
    pub(super) async fn sync_from_state(&self, state: &Value) {
        let session_file = state
            .get("sessionFile")
            .and_then(Value::as_str)
            .map(str::to_string);
        let message_count = state
            .get("messageCount")
            .and_then(Value::as_i64)
            .unwrap_or(0);

        let existing_session_dir = self
            .registry
            .lock()
            .await
            .get_session(&self.session_id)
            .and_then(|s| s.session_dir.clone());

        let mut patch = SessionPatch {
            last_activity_at: Some(crate::ipc::now_iso8601()),
            ..Default::default()
        };
        if existing_session_dir.is_none() {
            if let Some(file) = &session_file {
                if let Some(parent) = std::path::Path::new(file).parent() {
                    patch.session_dir = Some(parent.to_string_lossy().into_owned());
                }
            }
        }
        if message_count > 0 {
            patch.last_message_count = Some(Some(message_count));
            patch.current_conversation = Some(session_file.clone());
        }
        if let Some(model) = state.get("model") {
            if let (Some(provider), Some(id)) = (
                model.get("provider").and_then(Value::as_str),
                model.get("id").and_then(Value::as_str),
            ) {
                if !provider.is_empty() && !id.is_empty() {
                    let name = model.get("name").and_then(Value::as_str);
                    patch.last_model = Some(crate::store::registry::LastModel {
                        provider: truncate(provider, MAX_MODEL_FIELD_LENGTH),
                        id: truncate(id, MAX_MODEL_FIELD_LENGTH),
                        name: name.map(|n| truncate(n, MAX_MODEL_FIELD_LENGTH)),
                    });
                    let thinking_level = state.get("thinkingLevel").and_then(Value::as_str);
                    patch.last_thinking_level =
                        Some(thinking_level.map(|t| truncate(t, MAX_MODEL_FIELD_LENGTH)));
                }
            }
        }
        if self
            .registry
            .lock()
            .await
            .update_session(&self.session_id, patch)
            .await
            .is_ok()
        {
            self.events.emit_session_list_changed();
        }
    }

    pub(super) fn spawn_frame_listener(
        &self,
        proc: Arc<OmpProcess>,
        mut rx: tokio::sync::mpsc::UnboundedReceiver<ProcessEvent>,
    ) {
        let agent = self.arc();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Some(ProcessEvent::Frame(frame)) => agent.handle_frame(frame).await,
                    Some(ProcessEvent::StartProgress { stage, elapsed_ms }) => {
                        // Issue #784 ("Pre-declare per-lane Rust files"): the one extension point
                        // for every not-yet-landed lane's start-progress handling, same shape as
                        // `frame.rs`'s own `on_frame` fan-out.
                        crate::session::model::on_start_progress(&agent, stage, elapsed_ms).await;
                        crate::session::readout::on_start_progress(&agent, stage, elapsed_ms).await;
                        crate::session::side_chat::on_start_progress(&agent, stage, elapsed_ms)
                            .await;
                        crate::session::start_queue::on_start_progress(&agent, stage, elapsed_ms)
                            .await;
                        crate::session::subagents::on_start_progress(&agent, stage, elapsed_ms)
                            .await;
                        crate::session::termination::on_start_progress(&agent, stage, elapsed_ms)
                            .await;
                    }
                    Some(ProcessEvent::Exit { code, requested }) => {
                        let (is_current, stop_requested, was_already_stopped, epoch_at_exit) =
                            agent.handle_exit(&proc, code, requested).await;
                        // Issue #784: the same extension point for every not-yet-landed lane's
                        // exit handling, same shape as `frame.rs`'s own `on_frame` fan-out.
                        crate::session::model::on_exit(&agent, code, requested).await;
                        crate::session::readout::on_exit(&agent, code, requested).await;
                        crate::session::side_chat::on_exit(&agent, code, requested).await;
                        crate::session::subagents::on_exit(&agent, code, requested).await;
                        // Lane R3 (issue #786, gate-fix): gated on `is_current` -- a stale exit
                        // for an already-superseded life must never clear a NEWER attempt's own
                        // cancel handle/stage or recompute its termination verdict.
                        // `start_queue::on_exit` is passed `stop_requested` (the Session's own
                        // flag), never the raw `requested` above. `termination::on_exit` needs
                        // BOTH the raw `requested` (its own `requested && !stop_requested` early
                        // return, a launch()-internal cleanup stop) AND `was_already_stopped`
                        // (skips recomputing a crash verdict entirely once something more
                        // authoritative already settled this life's status before this exit
                        // event was even processed, the same race `should_apply_crash_exit_
                        // verdict` guards for `handle_exit`'s own status write), AND
                        // `epoch_at_exit` (round 6 gate-fix) -- captured by `handle_exit` under
                        // its own lock, checked by `termination::on_exit` before every state
                        // write it makes, not just the persisted marker.
                        if is_current {
                            crate::session::start_queue::on_exit(&agent, code, stop_requested)
                                .await;
                            crate::session::termination::on_exit(
                                &agent,
                                code,
                                requested,
                                stop_requested,
                                was_already_stopped,
                                epoch_at_exit,
                            )
                            .await;
                        }
                        break;
                    }
                    // The unbounded `mpsc` channel never lags; it only closes when the process
                    // itself is gone (every sender dropped).
                    None => break,
                }
            }
        });
    }

    /// Adds an error notice and moves the runtime to `stopped`/`start-failed` (data-model.md
    /// "Reattach verification" step 3), so a failed spawn or reattach never leaves a blank chat.
    /// `pub(in crate::session)` (not `pub(super)`): lane R3 (issue #786) calls this from
    /// `session::start_queue`'s own cancel paths, a sibling of `session::agent`, not a
    /// descendant of it.
    pub(in crate::session) async fn record_start_failure(&self, detail: &str) {
        self.append_notice(detail.to_string(), "error").await;
        self.set_status(
            SessionStatus::Stopped,
            Some("start-failed"),
            Some(detail.to_string()),
        )
        .await;
    }

    /// `sessions.stopAgent` (T040) and the app-exit stop-all path (`lib.rs`'s `ExitRequested`
    /// handler): closes stdin, awaits a graceful exit up to the grace period, then force-kills
    /// via the Job Object's owning process tree (`OmpProcess::stop`'s own `taskkill /T /F`
    pub async fn shutdown(&self) {
        {
            let mut state = self.state.lock().await;
            state.stop_requested = true;
            // Bumped alongside, under this SAME lock, before `start_lock` is ever awaited
            // below -- see `bail_if_shutdown_raced`'s own doc comment.
            state.shutdown_generation = state.shutdown_generation.wrapping_add(1);
        }
        // Lane R3 (gate-fix TS cycles 2/3): reaches a start still queued/memory-deferring too
        // (`acquire_slot` has no live `process` yet) -- a no-op if nothing is starting.
        self.cancel_start().await;
        let proc = { self.state.lock().await.process.clone() };
        if let Some(proc) = &proc {
            proc.stop().await;
        }
        // Gate-fix (round 3, HIGH): covers a start already past `acquire_slot`, still inside
        // `OmpProcess::connect`/its own ready-wait -- no `state.process` yet for either step
        // above to find; without this, `sessions.delete`/`.archive` could remove the worktree
        // while `omp` was still alive inside it. Acquiring `start_lock` blocks until whichever
        // `start()`/`launch()` call holds it returns -- `stop_requested` is already `true`, so
        // `bail_if_stop_requested` ends that attempt quickly. Gate-fix (round 5, HIGH): the
        // guard is HELD (not dropped immediately) for the rest of this function, refusing any
        // NEW `start()` until `proc_after` below is dealt with.
        let _start_guard = self.start_lock.lock().await;
        // A start could have completed and recorded a fresh `state.process` in the narrow
        // window between the checks above and this lock acquisition -- stop it too, unless it
        // is the exact same process already stopped above.
        let proc_after = { self.state.lock().await.process.clone() };
        if let Some(proc_after) = &proc_after {
            if !proc.as_ref().is_some_and(|p| Arc::ptr_eq(p, proc_after)) {
                // Belt-and-braces: re-set immediately before stopping it, so this exit is never
                // misread as an unrequested crash.
                {
                    let mut state = self.state.lock().await;
                    state.stop_requested = true;
                }
                proc_after.stop().await;
            }
        }
    }
}
