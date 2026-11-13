// Start and reattach. Pure helpers live in the sibling `launch_support.rs`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};

use super::launch_support::{
    append_ask_dialog_unavailable_notice, assert_conversation_file_exists, fetch_all_messages,
    reattach_rebaseline_notice, registry_store_error_message, send_set_ask_dialog, to_process_mode,
    verify_reattach,
};
use super::{AgentError, SessionAgent, SessionStatus, DEFAULT_REQUEST_TIMEOUT_MS};
use crate::git::worktree_validity::{worktree_is_valid, WorktreeValidity};
use crate::omp::process::{OmpProcess, OmpProcessOptions, ProcessEvent};
use crate::session::side_chat::reset_after_start_with_conversation;
use crate::session::termination;
use crate::store::registry::{Session, SessionPatch};

impl SessionAgent {
    /// Refuses while the Session's worktree is being deleted. Called under `start_lock`, so a
    /// delete that claims the Session after the caller's earlier check cannot be raced.
    fn refuse_if_worktree_deleting(&self) -> Result<(), AgentError> {
        crate::ipc::sessions_lifecycle::delete_in_flight::refuse_if_deleting(&self.session_id)
            .map_err(|e| AgentError::new(e.code, e.message))
    }

    /// Starts the process, or joins a live one as a no-op. Serialised through `start_lock`.
    /// Refuses with `worktree-busy` while the worktree is being deleted.
    pub async fn start(&self) -> Result<(), AgentError> {
        self.start_inner(true).await
    }

    /// Like `start`, without the deleting check. Only for the refused-Delete restart, which runs
    /// while its own delete still holds the claim.
    pub async fn start_unchecked(&self) -> Result<(), AgentError> {
        self.start_inner(false).await
    }

    async fn start_inner(&self, refuse_when_deleting: bool) -> Result<(), AgentError> {
        // Snapshot the generation before taking `start_lock`, so a concurrent `shutdown()` is
        // seen. The re-check and the reset must share one lock acquisition.
        let generation_at_entry = self.state.lock().await.shutdown_generation;
        let _guard = self.start_lock.lock().await;
        if refuse_when_deleting {
            self.refuse_if_worktree_deleting()?;
        }
        {
            let mut state = self.state.lock().await;
            if state.shutdown_generation != generation_at_entry {
                drop(state);
                self.mark_stopped_not_started().await;
                return Err(AgentError::new(
                    "not-started",
                    "SessionAgent: start cancelled",
                ));
            }
            if state.process.is_some() {
                return Ok(());
            }
            state.stop_requested = false;
        }
        let session = self.require_session().await?;
        if self.worktree_validity(&session).await == WorktreeValidity::Invalid {
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

    /// Checks the worktree via git, not just the folder. `Unknown` never blocks a start,
    /// because a slow disk scan is not evidence that the worktree is missing.
    async fn worktree_validity(&self, session: &Session) -> WorktreeValidity {
        let repo_path = {
            let registry = self.registry.lock().await;
            registry
                .get_repository(&session.repository_id)
                .map(|r| r.path.clone())
        };
        match repo_path {
            Some(path) => {
                worktree_is_valid(Path::new(&path), Path::new(&session.worktree_path)).await
            }
            None => WorktreeValidity::Invalid,
        }
    }

    /// A passive open never calls `start()`, so a stopped Session with a missing worktree is
    /// relabelled here. Only an unexplained stop is changed.
    pub async fn mark_worktree_missing_if_invalid(&self) {
        if self.status().await != SessionStatus::Stopped {
            return;
        }
        let reason = self
            .runtime_view()
            .await
            .get("stopReason")
            .and_then(Value::as_str)
            .map(str::to_string);
        if !matches!(reason.as_deref(), None | Some("not-started")) {
            return;
        }
        let Ok(session) = self.require_session().await else {
            return;
        };
        if self.worktree_validity(&session).await == WorktreeValidity::Invalid {
            self.set_status(
                SessionStatus::Stopped,
                Some("worktree-missing"),
                Some(session.worktree_path.clone()),
            )
            .await;
        }
    }

    /// Resets side chat after the registry write, before `launch()`, so it runs even if the start fails.
    pub async fn start_with_conversation(&self, file: Option<String>) -> Result<(), AgentError> {
        // Same guards as `start()`.
        let generation_at_entry = self.state.lock().await.shutdown_generation;
        let _guard = self.start_lock.lock().await;
        self.refuse_if_worktree_deleting()?;
        {
            let mut state = self.state.lock().await;
            if state.shutdown_generation != generation_at_entry {
                drop(state);
                self.mark_stopped_not_started().await;
                return Err(AgentError::new(
                    "not-started",
                    "SessionAgent: start cancelled",
                ));
            }
            if state.process.is_some() || state.status != SessionStatus::Stopped {
                return Err(AgentError::new(
                    "not-idle",
                    format!(
                        "SessionAgent {}: cannot start while not idle",
                        self.session_id
                    ),
                ));
            }
            state.stop_requested = false;
        }
        let session = self.require_session().await?;
        if tokio::fs::metadata(&session.worktree_path).await.is_ok() {
            let prev = self.current_conversation_path().await;
            let patch = SessionPatch {
                current_conversation: Some(file.clone()),
                last_message_count: Some(None),
                ..Default::default()
            };
            self.registry
                .lock()
                .await
                .update_session(&self.session_id, patch)
                .await
                .map_err(|err| AgentError::new("git-failed", registry_store_error_message(err)))?;
            reset_after_start_with_conversation(self, file.as_deref(), Some(prev)).await;
        }
        let session = self.require_session().await?;
        self.launch(&session, "").await
    }

    pub(super) async fn launch(
        &self,
        session: &Session,
        failure_prefix: &str,
    ) -> Result<(), AgentError> {
        // A new life clears the previous life's stop marker.
        self.clear_stopped_on_request_marker().await;

        let approval_mode = self.settings.lock().await.get().approval_mode;
        let mut opts = OmpProcessOptions::new(
            PathBuf::from(&session.worktree_path),
            to_process_mode(approval_mode),
        );
        // Always set, so a Session out of Plan overrides a global plan.defaultOnStartup.
        opts.plan_mode = Some(crate::session::working_mode::plan_for_launch(self).await);
        // Both launch sites read the depth here, so a restart after a re-parent sees the new one.
        let tool_access = {
            let registry = self.registry.lock().await;
            crate::agent_tools::ToolAccess::for_session(&registry.snapshot().sessions, &session.id)
        };
        opts.extra_config =
            crate::agent_tools::overlay_config(&crate::data_dir(), tool_access).await;
        let setting_on = self.settings.lock().await.get().stacked_pull_requests;
        opts.stacked_prs = crate::github::gh_stack_state::stack_rules_enabled(
            setting_on,
            &crate::github::gh_stack_state::state(crate::github::gh_stack_state::runtime()).await,
        );

        // Process-wide start slot and low-memory defer.
        let slot_guard = crate::session::start_queue::acquire_slot(self).await?;
        // Clears the stage on every return path, so a failed start never leaves it stuck.
        let _stage_guard = crate::session::start_queue::guard_stage_for_attempt(self);

        let mut launch_warnings = Vec::new();
        // Detached so the filesystem walk never delays the launch; the notice emits when ready.
        let roster_agent = self.arc();
        let roster_cwd = PathBuf::from(&session.worktree_path);
        tokio::spawn(async move {
            if let Some(roster) = crate::omp::advisor_roster::detect_for(Some(roster_cwd)).await {
                roster_agent
                    .events()
                    .emit_advisor_roster_detected(&roster_agent.session_id, &roster);
            }
        });
        let connected = OmpProcess::connect_with_warnings(&opts, &mut launch_warnings).await;
        for reason in launch_warnings {
            self.events()
                .emit_token_guard_warning(&self.session_id, &reason);
        }
        let proc = match connected {
            Ok(p) => p,
            Err(err) => {
                let detail = format!("{failure_prefix}{}", err.message);
                self.record_start_failure(&detail).await;
                return Err(AgentError::new("start-failed", detail));
            }
        };
        let proc = Arc::new(proc);
        // Awaited, so this write always precedes any later `remove_process_record` for the pid.
        let spawned_guard = crate::session::start_queue::mark_spawned();
        if let Some(pid) = proc.pid() {
            crate::process::pid_records::record_process(pid, &self.session_id).await;
        }
        // Clears the previous life's slash-command list before the frame listener starts,
        // so it cannot wipe this life's own list.
        {
            self.state.lock().await.commands = Vec::new();
        }
        // Subscribed before `wait_ready`, so no frame, including ready-wait frames, is missed.
        self.spawn_frame_listener(proc.clone(), proc.subscribe());
        // A cancel from here on must stop the spawned process, not just abandon the wait.
        let cancel_watch = crate::session::start_queue::watch_for_cancel(self, proc.clone()).await;
        let wait_result = proc.wait_ready(&opts).await;
        // Released here, before reattach and history fetch, so a late cancel cannot kill a ready agent.
        drop(cancel_watch);
        drop(slot_guard);
        drop(spawned_guard);
        if let Err(err) = wait_result {
            // A cancel already recorded its status, so skip the generic exit-before-ready error.
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
        // Clears any start-progress stage as soon as the ready frame arrives.
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
            // A new process life starts with no turn in flight.
            state.turn_abort_requested = false;
        }

        let state_data = match self.attach_and_verify(&proc, session).await {
            Ok(data) => data,
            Err(err) => {
                proc.stop().await;
                self.state.lock().await.process = None;
                // A `shutdown()` racing this await also fails the attach, so re-check the stop flag
                // and end stopped, not start-failed.
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
        let ask_dialog_enabled = send_set_ask_dialog(self, &proc).await;
        crate::agent_tools::register_host_tools(&proc, tool_access).await;
        // Compares the pre-launch count with the observed state before `sync_from_state` re-baselines it.
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
        let conv = session.current_conversation.as_deref();
        let terminated_unexpectedly =
            complete && termination::detect_unexpected_termination_for_transcript(conv).await;

        // A concurrent exit may clear `process` during the history fetch.
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
                let transcript = &mut state.transcript;
                transcript.merge_from_history(&messages, terminated_unexpectedly);
            }
        }
        // After the merge above, so the notice is not dropped as unpersisted.
        append_ask_dialog_unavailable_notice(self, ask_dialog_enabled).await;
        // Sent before `sync_from_state` re-baselines `last_message_count`.
        if let Some(notice) = rebaseline_notice {
            self.append_notice(notice, "info").await;
        }
        crate::session::subagents::on_attach_reconcile(self).await;
        crate::session::readout::on_launch(self).await;
        crate::session::advisor::on_launch(self).await;
        crate::session::prewalk::on_launch(self).await;
        if complete {
            crate::session::token_guard::on_history_loaded(self, &messages).await;
            crate::session::readout::on_history_loaded(self, &messages).await;
        }
        self.sync_from_state(&state_data, None).await;
        self.fail_if_process_changed(&proc, failure_prefix).await?;

        self.emit_status().await;
        self.emit_patch_reset().await;
        // A choice made while stopped applies before the first prompt.
        crate::session::pending_selection::drain(self).await;
        Ok(())
    }

    /// Fails the attempt when a concurrent exit cleared `state.process` mid-launch. A
    /// requested stop ends stopped, not start-failed.
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

    /// Switches to the Session's conversation (skipped when new), then verifies with `get_state`.
    /// Returns `Err` on failure; the caller stops `proc`.
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
    // `sync_from_state` lives in `sync_from_state.rs`.
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
                        // Extension point for start-progress handling.
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
                        // Extension point for exit handling.
                        crate::session::model::on_exit(&agent, code, requested).await;
                        crate::session::side_chat::on_exit(&agent, code, requested).await;
                        // Gated on `is_current`, so a stale exit cannot affect a newer life.
                        if is_current {
                            crate::session::working_mode::on_exit(&agent, requested).await;
                            crate::session::advisor::on_exit(&agent).await;
                            crate::session::readout::on_exit(&agent, code, requested).await;
                            crate::session::subagents::on_exit(
                                &agent,
                                code,
                                requested,
                                stop_requested,
                            )
                            .await;
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
                    // The unbounded channel closes only when the process is gone.
                    None => break,
                }
            }
        });
    }

    /// Adds an error notice and sets `start-failed`, so a failed start never leaves a blank chat.
    /// `pub(in crate::session)`: also called from `session::start_queue`.
    pub(in crate::session) async fn record_start_failure(&self, detail: &str) {
        self.append_notice(detail.to_string(), "error").await;
        self.set_status(
            SessionStatus::Stopped,
            Some("start-failed"),
            Some(detail.to_string()),
        )
        .await;
    }

    /// Closes stdin, waits for a graceful exit, then force-kills the process tree.
    pub async fn shutdown(&self) {
        {
            let mut state = self.state.lock().await;
            state.stop_requested = true;
            // Bumped under this lock, before `start_lock` is awaited.
            state.shutdown_generation = state.shutdown_generation.wrapping_add(1);
        }
        // Also reaches a start still queued or deferred, which has no process yet.
        self.cancel_start().await;
        let proc = { self.state.lock().await.process.clone() };
        if let Some(proc) = &proc {
            proc.stop().await;
        }
        // Waits for an in-flight `start()` to return, so its process cannot outlive this stop.
        // Held to the end of this function, so no new `start()` begins meanwhile.
        let _start_guard = self.start_lock.lock().await;
        // A start may have recorded a new process in the gap above, so stop it too.
        let proc_after = { self.state.lock().await.process.clone() };
        if let Some(proc_after) = &proc_after {
            if !proc.as_ref().is_some_and(|p| Arc::ptr_eq(p, proc_after)) {
                // Set the stop flag first, so this exit is not read as a crash.
                {
                    let mut state = self.state.lock().await;
                    state.stop_requested = true;
                }
                proc_after.stop().await;
            }
        }
    }
}

#[cfg(test)]
#[path = "launch.test.rs"]
mod tests;
