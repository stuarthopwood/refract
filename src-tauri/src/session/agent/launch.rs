// Start / reattach (port of `SessionAgent.ts`'s `start`/`doStart`/`launch`/`attachAndVerify`),
// plus the free functions only this flow needs (`reattachVerification.ts`'s `verifyReattach`,
// `fetchAllMessages.ts`). See `mod.rs`'s own header for this module's place in the `agent/`
// split and the lane extension contract.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::omp::process::{
    ApprovalMode as ProcApprovalMode, OmpProcess, OmpProcessOptions, ProcessEvent,
};
use crate::store::registry::{Session, SessionPatch};
use crate::store::settings::ApprovalMode;

use super::{
    AgentError, SessionAgent, SessionStatus, DEFAULT_REQUEST_TIMEOUT_MS, MAX_MESSAGE_PAGES,
    MAX_MODEL_FIELD_LENGTH, MESSAGES_PAGE_SIZE,
};

impl SessionAgent {
    /// `sessions.open`'s auto-start path and the initial `start()` call alike. Joins an
    /// already-live process as a no-op (simplified "join the in-flight attempt" behaviour: the
    /// TS original shares the exact in-flight `Promise`; this serialises instead through
    /// `start_lock`, which gives the same externally-visible result for every caller here).
    pub async fn start(&self) -> Result<(), AgentError> {
        let _guard = self.start_lock.lock().await;
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
        if tokio::fs::metadata(&session.worktree_path).await.is_err() {
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
        let _guard = self.start_lock.lock().await;
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
        let approval_mode = self.settings.lock().await.get().approval_mode;
        let opts = OmpProcessOptions::new(
            PathBuf::from(&session.worktree_path),
            to_process_mode(approval_mode),
        );

        let proc = match OmpProcess::connect(&opts).await {
            Ok(p) => p,
            Err(err) => {
                let detail = format!("{failure_prefix}{}", err.message);
                self.record_start_failure(&detail).await;
                return Err(AgentError::new("start-failed", detail));
            }
        };
        let proc = Arc::new(proc);
        // Subscribed before `wait_ready` (code-review/perf finding, 2026-10-13): registers this
        // listener before any frame -- including ones the ready-wait itself observes -- can
        // possibly be produced, the same guarantee `OmpProcess.ts` gets from attaching
        // `proc.on('frame', ...)` before calling `start()` (SessionAgent.ts:471).
        self.spawn_frame_listener(proc.clone(), proc.subscribe());
        if let Err(err) = proc.wait_ready(&opts).await {
            let detail = format!("{failure_prefix}{}", err.message);
            self.record_start_failure(&detail).await;
            return Err(AgentError::new("start-failed", detail));
        }

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
                let detail = format!("{failure_prefix}{err}");
                self.record_start_failure(&detail).await;
                return Err(AgentError::new("reattach-failed", detail));
            }
        };

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
        if self.state.lock().await.process.as_ref().map(Arc::as_ptr) != Some(Arc::as_ptr(&proc)) {
            let detail = format!("{failure_prefix}agent exited during start");
            self.record_start_failure(&detail).await;
            return Err(AgentError::new("start-failed", detail));
        }

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

        self.sync_from_state(&state_data).await;

        if self.state.lock().await.process.as_ref().map(Arc::as_ptr) != Some(Arc::as_ptr(&proc)) {
            let detail = format!("{failure_prefix}agent exited during start");
            self.record_start_failure(&detail).await;
            return Err(AgentError::new("start-failed", detail));
        }

        self.emit_status().await;
        self.emit_patch_reset().await;
        Ok(())
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
            if tokio::fs::metadata(conversation).await.is_err() {
                return Err(format!("Conversation file missing: {conversation}"));
            }
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
                    Some(ProcessEvent::StartProgress { .. }) => {}
                    Some(ProcessEvent::Exit { code, requested }) => {
                        agent.handle_exit(&proc, code, requested).await;
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
    pub(super) async fn record_start_failure(&self, detail: &str) {
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
    /// fallback, FR-004).
    pub async fn shutdown(&self) {
        {
            let mut state = self.state.lock().await;
            state.stop_requested = true;
        }
        let proc = { self.state.lock().await.process.clone() };
        if let Some(proc) = proc {
            proc.stop().await;
        }
    }
}

/// `RegistryStoreError` has no `Display` impl (only its `Registry` variant's inner
/// `RegistryError` does); mirrors `ipc::map_registry_error`'s own match for the message half.
fn registry_store_error_message(err: crate::store::registry::RegistryStoreError) -> String {
    match err {
        crate::store::registry::RegistryStoreError::Registry(e) => e.message,
        crate::store::registry::RegistryStoreError::Io(e) => e.to_string(),
    }
}

fn to_process_mode(mode: ApprovalMode) -> ProcApprovalMode {
    match mode {
        ApprovalMode::Ask => ProcApprovalMode::Ask,
        ApprovalMode::EditFreely => ProcApprovalMode::EditFreely,
        ApprovalMode::Auto => ProcApprovalMode::Auto,
    }
}

/// Also used by `agent::requests`'s own `pick_approval_target` to bound approval-dialog target
/// strings; kept here with the rest of this module's field-length truncation.
pub(super) fn truncate(s: &str, max_len: usize) -> String {
    s.chars().take(max_len).collect()
}

/// Port of `reattachVerification.ts`'s own `verifyReattach`. Windows paths are compared
/// case-insensitively without canonicalisation (both sides are already absolute paths from the
/// registry/OMP itself, unlike `path.resolve`'s own relative-path handling).
pub(super) fn verify_reattach(expected_file: &str, state: &Value) -> Result<(), String> {
    let session_file = state
        .get("sessionFile")
        .and_then(Value::as_str)
        .unwrap_or("");
    if session_file.to_lowercase() != expected_file.to_lowercase() {
        return Err(format!("Reattach verification failed: sessionFile mismatch (expected {expected_file}, got {session_file})"));
    }
    let message_count = state
        .get("messageCount")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if message_count <= 0 {
        return Err(format!("Reattach verification failed: messageCount is {message_count}, expected greater than 0"));
    }
    Ok(())
}

/// Port of `fetchAllMessages.ts`: bounded `get_messages_page` pagination, falling back to a
/// single plain `get_messages` call if the very first page fails. Never fails outright -- an
/// incomplete fetch (`complete: false`) returns whatever was already accumulated.
pub(super) async fn fetch_all_messages(proc: &OmpProcess) -> (Vec<Value>, bool) {
    let mut all: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    for page in 0..MAX_MESSAGE_PAGES {
        let mut cmd = json!({ "type": "get_messages_page", "limit": MESSAGES_PAGE_SIZE });
        if let Some(cursor) = &cursor {
            cmd["cursor"] = Value::String(cursor.clone());
        }
        let res = match proc.request(cmd, DEFAULT_REQUEST_TIMEOUT_MS).await {
            Ok(res) => res,
            Err(_) if page == 0 => return fallback_to_get_messages(proc).await,
            Err(_) => return (all, false),
        };
        if res.get("success").and_then(Value::as_bool) != Some(true) {
            if page == 0 {
                return fallback_to_get_messages(proc).await;
            }
            return (all, false);
        }
        let data = res.get("data");
        let messages = data
            .and_then(|d| d.get("messages"))
            .and_then(Value::as_array);
        let total_messages = data
            .and_then(|d| d.get("totalMessages"))
            .and_then(Value::as_u64);
        let (Some(messages), Some(total_messages)) = (messages, total_messages) else {
            if page == 0 {
                return fallback_to_get_messages(proc).await;
            }
            return (all, false);
        };
        let next_cursor = data
            .and_then(|d| d.get("nextCursor"))
            .and_then(Value::as_str)
            .map(str::to_string);
        if next_cursor.is_some() && (messages.is_empty() || next_cursor == cursor) {
            return (all, false);
        }
        all.extend(messages.iter().cloned());
        if all.len() as u64 >= total_messages {
            return (all, true);
        }
        let Some(next_cursor) = next_cursor else {
            return (all, false);
        };
        cursor = Some(next_cursor);
    }
    (all, false)
}

async fn fallback_to_get_messages(proc: &OmpProcess) -> (Vec<Value>, bool) {
    let res = match proc
        .request(
            json!({ "type": "get_messages" }),
            DEFAULT_REQUEST_TIMEOUT_MS,
        )
        .await
    {
        Ok(res) => res,
        Err(_) => return (Vec::new(), false),
    };
    let messages = res
        .get("data")
        .and_then(|d| d.get("messages"))
        .and_then(Value::as_array);
    if res.get("success").and_then(Value::as_bool) != Some(true) || messages.is_none() {
        return (Vec::new(), false);
    }
    (messages.unwrap().clone(), true)
}
