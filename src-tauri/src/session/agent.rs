// Port of `src/main/omp/SessionAgent.ts` (tasks.md T022): one instance per opened Session, owns
// one `omp::process::OmpProcess`, the Session's in-memory runtime status/transcript/queue/
// pending-request state, the approval-mode-aware prompt send/stop/answer loop, slash-command
// filtering, `startNewConversation`/`openConversation`, and the stopped-Session Conversation
// switch (port of `src/main/omp/conversationSwitch.ts`'s `startStoppedSessionOnConversation`).
//
// Explicit scope cut (assignment brief): subagents, side chat (`btw`), the spec-004 readout chip
// bundle, `predict_word`/`predict_word_feedback`, and model roles are not ported -- their frames
// are decoded by `apply_transcript_frame` where OMP's own wire shape requires it (so the main
// transcript still renders correctly), but no subagent panel, side-chat store, readout chip, or
// ghost-text completion exists in this build.
//
// Further simplifications made to fit this slice's scope (see the final report for the full
// list): no `restart()`/approval-mode-change auto-restart (`settings.setApprovalMode` persists
// and broadcasts `settings:changed`, T028, but does not yet respawn a live Session); no
// ready-wait retry-on-ceiling loop (`OmpProcess::spawn` itself has no caller-visible retry); no
// live start-progress banner (`SessionStartProgress`) events; `detectUnexpectedTermination`'s
// crash-tail detection is not ported, so `terminatedUnexpectedly` is always absent/`false`; the
// persisted `stoppedOnRequestConversation`/`stoppedOnRequestAtSize` marker is not written, so a
// deliberate Stop followed by a full app restart cannot be distinguished from a crash the way the
// Electron build distinguishes it; `openConversation`'s failed-switch recovery is simplified to
// "stop and mark stopped/start-failed" rather than TS's "try switching back to the previous
// Conversation first"; pending approval/question requests are not also mirrored into the main
// transcript as a `kind: 'request'` row (the `omp::transcript::TranscriptState` facade this
// module is built against exposes no arbitrary-item insertion API, only `apply_frame` over real
// OMP frames) -- the approval workflow itself (`request:pending`/`request:resolved` events plus
// the `pending` list) is unaffected.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex, Weak};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{watch, Mutex as AsyncMutex};

use crate::events::EventSink;
use crate::omp::diff::{diff_transcript, PatchCoalescer, TranscriptOp};
use crate::omp::process::{ApprovalMode as ProcApprovalMode, OmpProcess, OmpProcessOptions, ProcessEvent};
use crate::omp::transcript::TranscriptState;
use crate::store::registry::{RegistryStore, Session, SessionPatch};
use crate::store::settings::{ApprovalMode, SettingsStore};

/// Mirrors `OmpProcess.ts`'s own `DEFAULT_REQUEST_TIMEOUT_MS`; not exported by `omp::process`
/// (private there), so re-declared here with the same value for every `request()` call this
/// module makes.
const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 60_000;
/// Port of `SessionAgent.ts`'s own `ABORT_SETTLE_TIMEOUT_MS` ("about two minutes worst case").
const ABORT_SETTLE_TIMEOUT_MS: u64 = 60_000;
/// Port of `fetchAllMessages.ts`'s own `MESSAGES_PAGE_SIZE`.
const MESSAGES_PAGE_SIZE: u64 = 200;
/// Port of `fetchAllMessages.ts`'s own page-count safety cap.
const MAX_MESSAGE_PAGES: u32 = 10_000;
/// Port of `SessionAgent.ts`'s own `MAX_MODEL_FIELD_LENGTH` (security audit finding, 2026-10-03).
const MAX_MODEL_FIELD_LENGTH: usize = 256;

pub type SharedRegistry = Arc<AsyncMutex<RegistryStore>>;
pub type SharedSettings = Arc<AsyncMutex<SettingsStore>>;

/// `src/shared/model.ts`'s own `SessionStatus` union.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionStatus {
    Idle,
    Working,
    NeedsYou,
    Stopped,
}

/// Errors a `SessionAgent` method can produce; `code` matches one of `src/shared/ipc.ts`'s
/// `IpcErrorCode` values (`ipc::chat::map_chat_error`/`ipc::map_session_thrown`-equivalent
/// mapping happens at the IPC layer, not here).
#[derive(Debug)]
pub struct AgentError {
    pub code: &'static str,
    pub message: String,
}

impl AgentError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl std::fmt::Display for AgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AgentError {}

/// `src/shared/model.ts`'s own `PendingRequest` union (`dialogs.ts`'s `classifyDialog` output).
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PendingRequest {
    #[serde(rename = "approval")]
    Approval { request_id: String, tool: String, target: String, details: Vec<String> },
    #[serde(rename = "question")]
    Question {
        request_id: String,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        options: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        option_details: Option<Vec<Option<String>>>,
        input_kind: &'static str,
    },
}

impl PendingRequest {
    fn request_id(&self) -> &str {
        match self {
            Self::Approval { request_id, .. } | Self::Question { request_id, .. } => request_id,
        }
    }
}

struct AgentState {
    status: SessionStatus,
    stop_reason: Option<&'static str>,
    stop_detail: Option<String>,
    launched_mode: ApprovalMode,
    pending_mode: Option<ApprovalMode>,
    unread: bool,
    transcript: TranscriptState,
    queue_follow_up: Vec<String>,
    queue_steering: Vec<String>,
    pending: Vec<PendingRequest>,
    commands: Vec<Value>,
    process: Option<Arc<OmpProcess>>,
    turn_settle_handled: bool,
    stop_requested: bool,
}

/// One per opened Session (`session::manager::SessionManager::get_or_create_agent`). See this
/// file's own header for the scope this slice ports and the simplifications it makes.
pub struct SessionAgent {
    self_ref: Weak<SessionAgent>,
    session_id: String,
    registry: SharedRegistry,
    settings: SharedSettings,
    events: EventSink,
    visible_ids: Arc<StdMutex<HashSet<String>>>,
    state: AsyncMutex<AgentState>,
    status_tx: watch::Sender<SessionStatus>,
    start_lock: AsyncMutex<()>,
    coalescer: PatchCoalescer,
}

impl SessionAgent {
    pub fn new(
        session_id: String,
        registry: SharedRegistry,
        settings: SharedSettings,
        events: EventSink,
        visible_ids: Arc<StdMutex<HashSet<String>>>,
    ) -> Arc<Self> {
        let (status_tx, _rx) = watch::channel(SessionStatus::Stopped);
        let flush_session_id = session_id.clone();
        let flush_events = events.clone();
        let flush_visible_ids = visible_ids.clone();
        let coalescer = PatchCoalescer::new(
            std::time::Duration::from_millis(50),
            Box::new(move |ops: Vec<TranscriptOp>| {
                // Port of `SessionManager.ts`'s own `agent.on('patch', ...)` listener: a hidden
                // Session's patches are still computed (the coalescer always flushes) but never
                // forwarded, matching `visibleSessionIds.has(payload.sessionId)`'s own gate.
                if !flush_visible_ids.lock().expect("visible_ids mutex poisoned").contains(&flush_session_id) {
                    return;
                }
                let ops_value = serde_json::to_value(&ops).expect("TranscriptOp is always JSON-serialisable");
                flush_events.emit_transcript_patch(&flush_session_id, &ops_value);
            }),
        );
        Arc::new_cyclic(|weak| Self {
            self_ref: weak.clone(),
            session_id,
            registry,
            settings,
            events,
            visible_ids,
            state: AsyncMutex::new(AgentState {
                status: SessionStatus::Stopped,
                stop_reason: None,
                stop_detail: None,
                launched_mode: ApprovalMode::Ask,
                pending_mode: None,
                unread: false,
                transcript: TranscriptState::new(),
                queue_follow_up: Vec::new(),
                queue_steering: Vec::new(),
                pending: Vec::new(),
                commands: Vec::new(),
                process: None,
                turn_settle_handled: false,
                stop_requested: false,
            }),
            status_tx,
            start_lock: AsyncMutex::new(()),
            coalescer,
        })
    }

    fn arc(&self) -> Arc<Self> {
        self.self_ref.upgrade().expect("SessionAgent dropped while a background task still referenced it")
    }

    fn is_visible(&self) -> bool {
        self.visible_ids.lock().expect("visible_ids mutex poisoned").contains(&self.session_id)
    }

    async fn require_session(&self) -> Result<Session, AgentError> {
        self.registry
            .lock()
            .await
            .get_session(&self.session_id)
            .cloned()
            .ok_or_else(|| AgentError::new("not-found", format!("SessionAgent {}: session not found in registry", self.session_id)))
    }

    // -----------------------------------------------------------------------------------------
    // Status / events
    // -----------------------------------------------------------------------------------------

    fn status_event_locked(&self, state: &AgentState) -> Value {
        json!({
            "sessionId": self.session_id,
            "status": state.status,
            "stopReason": state.stop_reason,
            "stopDetail": state.stop_detail,
            "terminatedUnexpectedly": Value::Null,
            "startProgress": Value::Null,
            "unread": state.unread,
            "launchedMode": state.launched_mode,
            "pendingMode": state.pending_mode,
        })
    }

    async fn emit_status(&self) {
        let state = self.state.lock().await;
        let payload = self.status_event_locked(&state);
        drop(state);
        self.events.emit_session_status(&payload);
    }

    /// Port of `SessionAgent.ts`'s own `setStatus`: becomes `unread` only on a `working` ->
    /// `idle` transition while this Session is not the visible one (T037). Window-focus is not
    /// tracked in this build (simplification, see this file's own header), so only visibility
    /// gates `unread`, not focus.
    async fn set_status(&self, status: SessionStatus, stop_reason: Option<&'static str>, stop_detail: Option<String>) {
        {
            let mut state = self.state.lock().await;
            let became_unread = state.status == SessionStatus::Working && status == SessionStatus::Idle && !self.is_visible();
            state.status = status;
            state.stop_reason = stop_reason;
            state.stop_detail = stop_detail;
            if became_unread {
                state.unread = true;
            }
            let _ = self.status_tx.send(status);
        }
        self.emit_status().await;
    }

    /// `sessions.setVisible` (T036/T037): clears `unread` once this Session becomes visible.
    pub async fn clear_unread(&self) {
        let changed = {
            let mut state = self.state.lock().await;
            if !state.unread {
                false
            } else {
                state.unread = false;
                true
            }
        };
        if changed {
            self.emit_status().await;
        }
    }

    /// `sessions.list()`'s live-runtime fields (completes the registry-only placeholder Phase
    /// 2(b) left, tasks.md T019's own "absent until the first `get_state`" default is simply
    /// this method never having run for a Session with no agent this run -- `SessionManager`
    /// only calls this for a Session that already has one).
    pub async fn summary_fields(&self) -> Value {
        let state = self.state.lock().await;
        json!({
            "status": state.status,
            "stopReason": state.stop_reason,
            "unread": state.unread,
            "launchedMode": state.launched_mode,
            "pendingMode": state.pending_mode,
        })
    }

    /// `SessionRuntimeView` (`sessions.open`/`.recover`/`conversations.startNew`/`.open`'s own
    /// `SessionSnapshot.runtime`).
    pub async fn runtime_view(&self) -> Value {
        let state = self.state.lock().await;
        json!({
            "sessionId": self.session_id,
            "status": state.status,
            "stopReason": state.stop_reason,
            "stopDetail": state.stop_detail,
            "unread": state.unread,
            "launchedMode": state.launched_mode,
            "pendingMode": state.pending_mode,
        })
    }

    pub async fn status(&self) -> SessionStatus {
        self.state.lock().await.status
    }

    pub async fn available_commands(&self) -> Vec<Value> {
        self.state.lock().await.commands.clone()
    }

    // -----------------------------------------------------------------------------------------
    // Transcript
    // -----------------------------------------------------------------------------------------

    async fn apply_transcript_frame(&self, frame: &Value) {
        let mut state = self.state.lock().await;
        let before = state.transcript.items().to_vec();
        let changed = state.transcript.apply_frame(frame);
        if !changed {
            return;
        }
        let ops = diff_transcript(&before, state.transcript.items());
        drop(state);
        if !ops.is_empty() {
            self.coalescer.queue(ops);
        }
    }

    async fn append_notice(&self, text: String, level: &str) {
        self.apply_transcript_frame(&json!({ "type": "notice", "level": level, "message": text })).await;
    }

    /// Full-snapshot flush (`PatchCoalescer`'s `reset` semantics: "reset supersedes queue"),
    /// used at the end of `launch()`/`start_new_conversation()`/`open_conversation()`, and by
    /// `session::manager::SessionManager::set_visible` for a Session that just became visible
    /// (its patches were dropped by the coalescer's own visibility gate while hidden).
    pub async fn emit_patch_reset(&self) {
        let items = self.state.lock().await.transcript.items().to_vec();
        self.coalescer.queue(vec![TranscriptOp::Reset { items }]);
        self.coalescer.flush_now();
    }

    /// Adds an error notice and moves the runtime to `stopped`/`start-failed` (data-model.md
    /// "Reattach verification" step 3), so a failed spawn or reattach never leaves a blank chat.
    async fn record_start_failure(&self, detail: &str) {
        self.append_notice(detail.to_string(), "error").await;
        self.set_status(SessionStatus::Stopped, Some("start-failed"), Some(detail.to_string())).await;
    }

    // -----------------------------------------------------------------------------------------
    // Start / reattach (port of `SessionAgent.ts`'s `start`/`doStart`/`launch`/`attachAndVerify`)
    // -----------------------------------------------------------------------------------------

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
            self.set_status(SessionStatus::Stopped, Some("worktree-missing"), Some(session.worktree_path.clone())).await;
            return Err(AgentError::new("worktree-missing", format!("Worktree missing: {}", session.worktree_path)));
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
                return Err(AgentError::new("not-idle", format!("SessionAgent {}: cannot start while not idle", self.session_id)));
            }
        }
        {
            let mut state = self.state.lock().await;
            state.stop_requested = false;
        }
        let session = self.require_session().await?;
        if tokio::fs::metadata(&session.worktree_path).await.is_ok() {
            let patch = SessionPatch { current_conversation: Some(file), last_message_count: Some(None), ..Default::default() };
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

    async fn launch(&self, session: &Session, failure_prefix: &str) -> Result<(), AgentError> {
        let approval_mode = self.settings.lock().await.get().approval_mode;
        let opts = OmpProcessOptions::new(PathBuf::from(&session.worktree_path), to_process_mode(approval_mode));

        let proc = match OmpProcess::spawn(opts).await {
            Ok(p) => p,
            Err(err) => {
                let detail = format!("{failure_prefix}{}", err.message);
                self.record_start_failure(&detail).await;
                return Err(AgentError::new("start-failed", detail));
            }
        };
        let proc = Arc::new(proc);

        if self.state.lock().await.stop_requested {
            proc.stop().await;
            self.set_status(SessionStatus::Stopped, Some("not-started"), None).await;
            return Err(AgentError::new("not-started", "SessionAgent: stop requested during launch"));
        }

        {
            let mut state = self.state.lock().await;
            state.process = Some(proc.clone());
        }
        self.spawn_frame_listener(proc.clone());

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
            self.set_status(SessionStatus::Stopped, Some("not-started"), None).await;
            return Err(AgentError::new("not-started", "SessionAgent: stop requested during launch"));
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
            state.pending_mode = if current_mode == approval_mode { None } else { Some(current_mode) };
            if complete {
                let mut fresh = TranscriptState::from_history(&messages);
                let _ = fresh.settle_interrupted_tool_rows();
                state.transcript = fresh;
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
    async fn attach_and_verify(&self, proc: &OmpProcess, session: &Session) -> Result<Value, String> {
        if let Some(conversation) = &session.current_conversation {
            if tokio::fs::metadata(conversation).await.is_err() {
                return Err(format!("Conversation file missing: {conversation}"));
            }
            let switch_res = proc
                .request(json!({ "type": "switch_session", "sessionPath": conversation }), DEFAULT_REQUEST_TIMEOUT_MS)
                .await
                .map_err(|err| err.to_string())?;
            let cancelled = switch_res.get("data").and_then(|d| d.get("cancelled")).and_then(Value::as_bool);
            if switch_res.get("success").and_then(Value::as_bool) != Some(true) || cancelled != Some(false) {
                return Err(format!("switch_session failed or was cancelled for {conversation}"));
            }
        }
        let state_res = proc.request(json!({ "type": "get_state" }), DEFAULT_REQUEST_TIMEOUT_MS).await.map_err(|err| err.to_string())?;
        if state_res.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(format!("get_state failed: {}", state_res.get("error").and_then(Value::as_str).unwrap_or("unknown error")));
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
    async fn sync_from_state(&self, state: &Value) {
        let session_file = state.get("sessionFile").and_then(Value::as_str).map(str::to_string);
        let message_count = state.get("messageCount").and_then(Value::as_i64).unwrap_or(0);

        let existing_session_dir = self.registry.lock().await.get_session(&self.session_id).and_then(|s| s.session_dir.clone());

        let mut patch = SessionPatch { last_activity_at: Some(crate::ipc::now_iso8601()), ..Default::default() };
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
            if let (Some(provider), Some(id)) = (model.get("provider").and_then(Value::as_str), model.get("id").and_then(Value::as_str)) {
                if !provider.is_empty() && !id.is_empty() {
                    let name = model.get("name").and_then(Value::as_str);
                    patch.last_model = Some(crate::store::registry::LastModel {
                        provider: truncate(provider, MAX_MODEL_FIELD_LENGTH),
                        id: truncate(id, MAX_MODEL_FIELD_LENGTH),
                        name: name.map(|n| truncate(n, MAX_MODEL_FIELD_LENGTH)),
                    });
                    let thinking_level = state.get("thinkingLevel").and_then(Value::as_str);
                    patch.last_thinking_level = Some(thinking_level.map(|t| truncate(t, MAX_MODEL_FIELD_LENGTH)));
                }
            }
        }
        if self.registry.lock().await.update_session(&self.session_id, patch).await.is_ok() {
            self.events.emit_session_list_changed();
        }
    }

    // -----------------------------------------------------------------------------------------
    // Live frames (port of `SessionAgent.ts`'s own `onFrame`)
    // -----------------------------------------------------------------------------------------

    fn spawn_frame_listener(&self, proc: Arc<OmpProcess>) {
        let agent = self.arc();
        let mut rx = proc.subscribe();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(ProcessEvent::Frame(frame)) => agent.handle_frame(frame).await,
                    Ok(ProcessEvent::StartProgress { .. }) => {}
                    Ok(ProcessEvent::Exit { code, requested }) => {
                        agent.handle_exit(code, requested).await;
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    async fn handle_frame(&self, frame: Value) {
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
                let raw = frame.get("commands").and_then(Value::as_array).cloned().unwrap_or_default();
                let filtered = filter_supported_commands(&raw);
                {
                    let mut state = self.state.lock().await;
                    state.commands = filtered.clone();
                }
                let commands_value = Value::Array(filtered);
                self.events.emit_commands_update(&self.session_id, &commands_value);
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
            "tool_execution_start" | "tool_execution_end" | "tool_execution_update" => {
                self.apply_transcript_frame(&frame).await;
            }
            // `agent_end`, `btw_delta`/`btw_record` (side chat), and anything else: no-op, same
            // as `SessionAgent.ts`'s own default branch minus the subagent-IRC-message handling
            // this slice does not port.
            _ => {}
        }
    }

    async fn set_queue(&self, follow_up: Vec<String>, steering: Vec<String>) {
        {
            let mut state = self.state.lock().await;
            state.queue_follow_up = follow_up.clone();
            state.queue_steering = steering.clone();
        }
        self.events.emit_queue_update(&self.session_id, &follow_up, &steering);
    }

    async fn handle_extension_ui_request(&self, frame: &Value) {
        match classify_dialog(frame) {
            DialogClassification::Ignore => {}
            DialogClassification::Notify { message, level } => self.append_notice(message, &level).await,
            DialogClassification::Cancel(target) => {
                let became_working = {
                    let mut state = self.state.lock().await;
                    if !state.pending.iter().any(|r| r.request_id() == target) {
                        return;
                    }
                    state.pending.retain(|r| r.request_id() != target);
                    state.pending.is_empty() && state.status == SessionStatus::NeedsYou
                };
                self.append_notice("Request withdrawn: the agent cancelled it.".to_string(), "info").await;
                self.events.emit_request_resolved(&self.session_id, &target);
                if became_working {
                    self.set_status(SessionStatus::Working, None, None).await;
                }
            }
            DialogClassification::Request(request) => {
                let payload = serde_json::to_value(&request).expect("PendingRequest is always JSON-serialisable");
                {
                    let mut state = self.state.lock().await;
                    state.pending.push(request);
                    state.status = SessionStatus::NeedsYou;
                }
                self.events.emit_request_pending(&self.session_id, &payload);
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
            let ids: Vec<String> = state.pending.iter().map(|r| r.request_id().to_string()).collect();
            state.pending.clear();
            ids
        };
        for id in ids {
            self.events.emit_request_resolved(&self.session_id, &id);
        }
    }

    async fn on_session_settled(&self) {
        let proc = { self.state.lock().await.process.clone() };
        let Some(proc) = proc else { return };
        if let Ok(res) = proc.request(json!({ "type": "get_state" }), DEFAULT_REQUEST_TIMEOUT_MS).await {
            if res.get("success").and_then(Value::as_bool) == Some(true) {
                if let Some(data) = res.get("data") {
                    self.sync_from_state(data).await;
                }
            }
        }
    }

    /// Port of `SessionAgent.ts`'s own `onExit`, simplified: the `shouldApplyCrashExitVerdict`/
    /// `lifeEpoch` race guard is dropped (it exists only to protect a concurrent `restart()`,
    /// which this build does not implement -- see this file's own header), and
    /// `detectUnexpectedTermination`'s crash-tail read/the persisted stopped-on-request marker
    /// are not ported (`terminatedUnexpectedly` always absent).
    async fn handle_exit(&self, code: Option<i32>, requested: bool) {
        {
            let mut state = self.state.lock().await;
            state.process = None;
        }
        self.settle_turn_pending().await;
        if requested {
            let stop_requested = self.state.lock().await.stop_requested;
            if !stop_requested {
                // A `launch()`-internal cleanup stop (failed handshake/attach), never the user
                // asking to stop -- `launch()`'s own catch paths already recorded the real
                // stopped/start-failed status for this; nothing further to do here.
                return;
            }
            self.set_status(SessionStatus::Stopped, Some("not-started"), None).await;
            return;
        }
        self.set_status(SessionStatus::Stopped, Some("agent-exited"), Some(format!("exit code {code:?}"))).await;
    }

    // -----------------------------------------------------------------------------------------
    // Prompt / stop / answer (chat.send/.stop/.answer/.removeQueued)
    // -----------------------------------------------------------------------------------------

    /// `chat.send` (contracts/omp-usage.md "Send a message"): `message`, never `text`
    /// (constitution II). `images` is only attached when non-empty, matching `streamingBehavior`
    /// only being set while the turn is already `working`/`needs-you` (a steer/follow-up).
    pub async fn send(&self, text: String, images: Option<Vec<Value>>) -> Result<Value, AgentError> {
        let (proc, working) = {
            let state = self.state.lock().await;
            let proc = state.process.clone().ok_or_else(|| AgentError::new("agent-not-running", format!("SessionAgent {}: cannot send, no live process", self.session_id)))?;
            let working = matches!(state.status, SessionStatus::Working | SessionStatus::NeedsYou);
            (proc, working)
        };
        let mut cmd = json!({ "type": "prompt", "message": text });
        if let Some(images) = images {
            if !images.is_empty() {
                cmd["images"] = Value::Array(images);
            }
        }
        if working {
            cmd["streamingBehavior"] = Value::String("followUp".to_string());
        }
        let res = proc.request(cmd, DEFAULT_REQUEST_TIMEOUT_MS).await.map_err(|err| AgentError::new("prompt-failed", err.to_string()))?;
        if res.get("success").and_then(Value::as_bool) != Some(true) {
            let err_message = res.get("error").and_then(Value::as_str).unwrap_or("unknown error").to_string();
            let detail = format!("prompt failed: {err_message}");
            self.append_notice(detail.clone(), "error").await;
            return Err(AgentError::new("prompt-failed", detail));
        }
        Ok(json!({ "queued": working }))
    }

    /// `chat.stop` (contracts/omp-usage.md "Stop"): sends `abort`, then waits for the turn to
    /// fully settle before the Session accepts another prompt. A no-op while idle or with no
    /// live process.
    pub async fn stop(&self) -> Result<(), AgentError> {
        let (proc, status) = {
            let state = self.state.lock().await;
            (state.process.clone(), state.status)
        };
        let Some(proc) = proc else { return Ok(()) };
        if status == SessionStatus::Idle {
            return Ok(());
        }
        if let Ok(res) = proc.request(json!({ "type": "abort" }), DEFAULT_REQUEST_TIMEOUT_MS).await {
            if res.get("success").and_then(Value::as_bool) != Some(true) {
                let err_message = res.get("error").and_then(Value::as_str).unwrap_or("unknown error").to_string();
                self.append_notice(format!("abort failed: {err_message}"), "error").await;
            }
        }
        let mut rx = self.status_tx.subscribe();
        if matches!(*rx.borrow(), SessionStatus::Idle | SessionStatus::Stopped) {
            return Ok(());
        }
        let wait = async {
            while rx.changed().await.is_ok() {
                if matches!(*rx.borrow(), SessionStatus::Idle | SessionStatus::Stopped) {
                    return;
                }
            }
        };
        if tokio::time::timeout(std::time::Duration::from_millis(ABORT_SETTLE_TIMEOUT_MS), wait).await.is_err() {
            return Err(AgentError::new("prompt-failed", format!("SessionAgent {}: timed out waiting for idle", self.session_id)));
        }
        Ok(())
    }

    /// `chat.removeQueued` (issue #540): `queue` is the chip's own queue (`'followUp'` or
    /// `'steering'`) -- OMP's `remove_queued_message` only matches within the exact queue given.
    pub async fn remove_queued(&self, text: String, queue: &str) -> Result<Value, AgentError> {
        let proc = {
            self.state.lock().await.process.clone().ok_or_else(|| AgentError::new("agent-not-running", format!("SessionAgent {}: cannot remove a queued message, no live process", self.session_id)))?
        };
        let res = proc
            .request(json!({ "type": "remove_queued_message", "message": text, "queue": queue }), DEFAULT_REQUEST_TIMEOUT_MS)
            .await
            .map_err(|err| AgentError::new("prompt-failed", err.to_string()))?;
        if res.get("success").and_then(Value::as_bool) != Some(true) {
            let err_message = res.get("error").and_then(Value::as_str).unwrap_or("unknown error").to_string();
            let detail = format!("remove_queued_message failed: {err_message}");
            self.append_notice(detail.clone(), "error").await;
            return Err(AgentError::new("prompt-failed", detail));
        }
        let removed = res.get("data").and_then(|d| d.get("removed")).and_then(Value::as_bool).unwrap_or(false);
        Ok(json!({ "removed": removed }))
    }

    /// `chat.answer` (T028): writes the `extension_ui_response` for a still-pending request
    /// (via `OmpProcess::send_raw`, which preserves the ORIGINAL request's own `id` -- see that
    /// method's own doc comment) and marks it resolved.
    pub async fn answer_request(&self, request_id: String, answer: Value) -> Result<(), AgentError> {
        let (request, proc) = {
            let state = self.state.lock().await;
            let request = state
                .pending
                .iter()
                .find(|r| r.request_id() == request_id)
                .cloned()
                .ok_or_else(|| AgentError::new("not-found", format!("SessionAgent {}: no pending request {request_id}", self.session_id)))?;
            let proc = state.process.clone().ok_or_else(|| AgentError::new("agent-not-running", format!("SessionAgent {}: cannot answer, no live process", self.session_id)))?;
            (request, proc)
        };
        let response = build_dialog_response(&request_id, &request, &answer).map_err(|err| AgentError::new("invalid-argument", err))?;
        proc.send_raw(response).await.map_err(|err| AgentError::new("prompt-failed", err.to_string()))?;

        // `resolved`'s approved/denied/answered/cancelled distinction (`SessionAgent.ts`'s own
        // `resolvePendingRequest`) only ever fed the main-transcript `kind: 'request'` item's
        // own `resolved` field in the TS original; that mirroring is not ported here (see this
        // file's own header), so only `requestId` itself needs to reach `request:resolved`.
        let became_working = {
            let mut state = self.state.lock().await;
            state.pending.retain(|r| r.request_id() != request_id);
            state.pending.is_empty() && state.status == SessionStatus::NeedsYou
        };
        self.events.emit_request_resolved(&self.session_id, &request_id);
        if became_working {
            self.set_status(SessionStatus::Working, None, None).await;
        }
        Ok(())
    }

    // -----------------------------------------------------------------------------------------
    // Conversations (conversations.startNew/.open, agent-backed arms)
    // -----------------------------------------------------------------------------------------

    /// `conversations.startNew` (contracts/omp-usage.md "New Conversation"): same process, same
    /// worktree, a brand-new OMP session file. Only reachable while `idle` with a live process
    /// (a `stopped` Session instead goes through `start_with_conversation`).
    pub async fn start_new_conversation(&self) -> Result<(), AgentError> {
        let proc = {
            let state = self.state.lock().await;
            if state.status != SessionStatus::Idle || state.process.is_none() {
                return Err(AgentError::new("not-idle", format!("SessionAgent {}: cannot start a new Conversation while {:?}", self.session_id, state.status)));
            }
            state.process.clone().unwrap()
        };
        let res = proc.request(json!({ "type": "new_session" }), DEFAULT_REQUEST_TIMEOUT_MS).await.map_err(|err| AgentError::new("prompt-failed", err.to_string()))?;
        if res.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(AgentError::new(
                "prompt-failed",
                format!("new_session failed: {}", res.get("error").and_then(Value::as_str).unwrap_or("unknown error")),
            ));
        }
        let patch = SessionPatch { current_conversation: Some(None), last_message_count: Some(None), ..Default::default() };
        let _ = self.registry.lock().await.update_session(&self.session_id, patch).await;
        {
            let mut state = self.state.lock().await;
            state.transcript = TranscriptState::new();
        }
        self.emit_patch_reset().await;
        if let Ok(res) = proc.request(json!({ "type": "get_state" }), DEFAULT_REQUEST_TIMEOUT_MS).await {
            if res.get("success").and_then(Value::as_bool) == Some(true) {
                if let Some(data) = res.get("data") {
                    self.sync_from_state(data).await;
                }
            }
        }
        Ok(())
    }

    /// `conversations.open` (contracts/omp-usage.md "Open an earlier Conversation"): the same
    /// reattach verification `launch()` uses, reloading history AS-IS (never merged with the
    /// current live transcript -- this switches to a DIFFERENT Conversation). Simplified
    /// failure recovery (see this file's own header): a failed post-switch verification stops
    /// the process and marks the Session `stopped`/`start-failed`, rather than TS's own
    /// try-the-previous-Conversation-first recovery.
    pub async fn open_conversation(&self, file: String) -> Result<(), AgentError> {
        let proc = {
            let state = self.state.lock().await;
            if state.status != SessionStatus::Idle || state.process.is_none() {
                return Err(AgentError::new("not-idle", format!("SessionAgent {}: cannot open a Conversation while {:?}", self.session_id, state.status)));
            }
            state.process.clone().unwrap()
        };
        let switch_res = proc
            .request(json!({ "type": "switch_session", "sessionPath": file }), DEFAULT_REQUEST_TIMEOUT_MS)
            .await
            .map_err(|err| AgentError::new("reattach-failed", err.to_string()))?;
        let cancelled = switch_res.get("data").and_then(|d| d.get("cancelled")).and_then(Value::as_bool);
        if switch_res.get("success").and_then(Value::as_bool) != Some(true) || cancelled != Some(false) {
            return Err(AgentError::new("reattach-failed", format!("switch_session failed or was cancelled for {file}")));
        }

        let state_res = match proc.request(json!({ "type": "get_state" }), DEFAULT_REQUEST_TIMEOUT_MS).await {
            Ok(res) => res,
            Err(err) => {
                proc.stop().await;
                self.state.lock().await.process = None;
                let detail = err.to_string();
                self.record_start_failure(&detail).await;
                return Err(AgentError::new("reattach-failed", detail));
            }
        };
        if state_res.get("success").and_then(Value::as_bool) != Some(true) {
            proc.stop().await;
            self.state.lock().await.process = None;
            let detail = format!("get_state after switch_session failed: {}", state_res.get("error").and_then(Value::as_str).unwrap_or("unknown error"));
            self.record_start_failure(&detail).await;
            return Err(AgentError::new("reattach-failed", detail));
        }
        let data = state_res.get("data").cloned().unwrap_or(Value::Null);
        if let Err(failure) = verify_reattach(&file, &data) {
            proc.stop().await;
            self.state.lock().await.process = None;
            self.record_start_failure(&failure).await;
            return Err(AgentError::new("reattach-failed", failure));
        }

        let (messages, complete) = fetch_all_messages(&proc).await;
        {
            let mut state = self.state.lock().await;
            state.transcript = if complete {
                let mut fresh = TranscriptState::from_history(&messages);
                let _ = fresh.settle_interrupted_tool_rows();
                fresh
            } else {
                TranscriptState::new()
            };
        }
        self.sync_from_state(&data).await;
        self.emit_patch_reset().await;
        Ok(())
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

// ---------------------------------------------------------------------------
// Free functions (ports of reattachVerification.ts, fetchAllMessages.ts, dialogs.ts,
// slash-commands.ts classification)
// ---------------------------------------------------------------------------


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

fn truncate(s: &str, max_len: usize) -> String {
    s.chars().take(max_len).collect()
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

/// Port of `reattachVerification.ts`'s own `verifyReattach`. Windows paths are compared
/// case-insensitively without canonicalisation (both sides are already absolute paths from the
/// registry/OMP itself, unlike `path.resolve`'s own relative-path handling).
fn verify_reattach(expected_file: &str, state: &Value) -> Result<(), String> {
    let session_file = state.get("sessionFile").and_then(Value::as_str).unwrap_or("");
    if session_file.to_lowercase() != expected_file.to_lowercase() {
        return Err(format!("Reattach verification failed: sessionFile mismatch (expected {expected_file}, got {session_file})"));
    }
    let message_count = state.get("messageCount").and_then(Value::as_i64).unwrap_or(0);
    if message_count <= 0 {
        return Err(format!("Reattach verification failed: messageCount is {message_count}, expected greater than 0"));
    }
    Ok(())
}

/// Port of `fetchAllMessages.ts`: bounded `get_messages_page` pagination, falling back to a
/// single plain `get_messages` call if the very first page fails. Never fails outright -- an
/// incomplete fetch (`complete: false`) returns whatever was already accumulated.
async fn fetch_all_messages(proc: &OmpProcess) -> (Vec<Value>, bool) {
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
        let messages = data.and_then(|d| d.get("messages")).and_then(Value::as_array);
        let total_messages = data.and_then(|d| d.get("totalMessages")).and_then(Value::as_u64);
        let (Some(messages), Some(total_messages)) = (messages, total_messages) else {
            if page == 0 {
                return fallback_to_get_messages(proc).await;
            }
            return (all, false);
        };
        let next_cursor = data.and_then(|d| d.get("nextCursor")).and_then(Value::as_str).map(str::to_string);
        if next_cursor.is_some() && (messages.is_empty() || next_cursor == cursor) {
            return (all, false);
        }
        all.extend(messages.iter().cloned());
        if all.len() as u64 >= total_messages {
            return (all, true);
        }
        let Some(next_cursor) = next_cursor else { return (all, false) };
        cursor = Some(next_cursor);
    }
    (all, false)
}

async fn fallback_to_get_messages(proc: &OmpProcess) -> (Vec<Value>, bool) {
    let res = match proc.request(json!({ "type": "get_messages" }), DEFAULT_REQUEST_TIMEOUT_MS).await {
        Ok(res) => res,
        Err(_) => return (Vec::new(), false),
    };
    let messages = res.get("data").and_then(|d| d.get("messages")).and_then(Value::as_array);
    if res.get("success").and_then(Value::as_bool) != Some(true) || messages.is_none() {
        return (Vec::new(), false);
    }
    (messages.unwrap().clone(), true)
}

enum DialogClassification {
    Ignore,
    Cancel(String),
    Notify { message: String, level: String },
    Request(PendingRequest),
}

const APPROVAL_PREFIX: &str = "Allow tool:";
const MAX_TARGET_LENGTH: usize = 200;

/// Port of `dialogs.ts`'s own `parseApprovalTitle`. Only called once the caller has already
/// confirmed `title.starts_with(APPROVAL_PREFIX)`, so the first line always carries the prefix.
fn parse_approval_title(title: &str) -> (String, Vec<String>) {
    let first_line = title.split('\n').next().unwrap_or("");
    let tool = first_line.strip_prefix(APPROVAL_PREFIX).unwrap_or(first_line).trim().to_string();
    let details: Vec<String> = title.split('\n').skip(1).map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect();
    (tool, details)
}

fn pick_approval_target(tool: &str, details: &[String]) -> String {
    const LABELS: &[&str] = &["Path:", "File:", "Command:"];
    if let Some(first) = details.first() {
        for label in LABELS {
            if first.len() >= label.len() && first[..label.len()].eq_ignore_ascii_case(label) {
                return truncate(first[label.len()..].trim(), MAX_TARGET_LENGTH);
            }
        }
    }
    truncate(tool, MAX_TARGET_LENGTH)
}

/// Port of `dialogs.ts`'s own `classifyDialog`.
fn classify_dialog(frame: &Value) -> DialogClassification {
    let method = frame.get("method").and_then(Value::as_str).unwrap_or("");
    let id = frame.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    match method {
        "select" => {
            let title = frame.get("title").and_then(Value::as_str).unwrap_or("").to_string();
            if title.starts_with(APPROVAL_PREFIX) {
                let (tool, details) = parse_approval_title(&title);
                let target = pick_approval_target(&tool, &details);
                return DialogClassification::Request(PendingRequest::Approval { request_id: id, tool, target, details });
            }
            let options = string_array(frame.get("options"));
            let option_details = frame.get("optionDetails").and_then(Value::as_array).map(|list| {
                list.iter().map(|d| d.get("description").and_then(Value::as_str).map(str::to_string)).collect::<Vec<_>>()
            });
            DialogClassification::Request(PendingRequest::Question {
                request_id: id,
                title,
                message: None,
                options,
                option_details,
                input_kind: "choice",
            })
        }
        "input" | "editor" => DialogClassification::Request(PendingRequest::Question {
            request_id: id,
            title: frame.get("title").and_then(Value::as_str).unwrap_or("").to_string(),
            message: None,
            options: vec![],
            option_details: None,
            input_kind: "text",
        }),
        "confirm" => DialogClassification::Request(PendingRequest::Question {
            request_id: id,
            title: frame.get("title").and_then(Value::as_str).unwrap_or("").to_string(),
            message: frame.get("message").and_then(Value::as_str).map(str::to_string),
            options: vec!["Yes".to_string(), "No".to_string()],
            option_details: None,
            input_kind: "confirm",
        }),
        "cancel" => DialogClassification::Cancel(frame.get("targetId").and_then(Value::as_str).map(str::to_string).unwrap_or(id)),
        "notify" => DialogClassification::Notify {
            message: frame.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
            level: frame.get("notifyType").and_then(Value::as_str).unwrap_or("info").to_string(),
        },
        _ => DialogClassification::Ignore,
    }
}

/// Port of `dialogs.ts`'s own `buildDialogResponse`.
fn build_dialog_response(request_id: &str, request: &PendingRequest, answer: &Value) -> Result<Value, String> {
    if answer.get("cancelled") == Some(&Value::Bool(true)) {
        return Ok(json!({ "type": "extension_ui_response", "id": request_id, "cancelled": true }));
    }
    if matches!(request, PendingRequest::Approval { .. }) {
        let approve = answer.get("approve").and_then(Value::as_bool).ok_or_else(|| format!("expected an approve answer for approval request {request_id}"))?;
        return Ok(json!({ "type": "extension_ui_response", "id": request_id, "value": if approve { "Approve" } else { "Deny" } }));
    }
    if let PendingRequest::Question { input_kind, .. } = request {
        if *input_kind == "confirm" {
            if let Some(value) = answer.get("value").and_then(Value::as_str) {
                return Ok(json!({ "type": "extension_ui_response", "id": request_id, "confirmed": value == "Yes" }));
            }
        }
    }
    if let Some(confirmed) = answer.get("confirmed").and_then(Value::as_bool) {
        return Ok(json!({ "type": "extension_ui_response", "id": request_id, "confirmed": confirmed }));
    }
    if let Some(value) = answer.get("value").and_then(Value::as_str) {
        return Ok(json!({ "type": "extension_ui_response", "id": request_id, "value": value }));
    }
    Err(format!("unsupported dialog answer for request {request_id}"))
}

/// `chat.answer`'s own wire-shape validation (port of `chat.ts`'s own `isChatAnswer`).
pub fn is_chat_answer(value: &Value) -> bool {
    let Some(obj) = value.as_object() else { return false };
    matches!(obj.get("approve"), Some(Value::Bool(_)))
        || matches!(obj.get("value"), Some(Value::String(_)))
        || matches!(obj.get("confirmed"), Some(Value::Bool(_)))
        || obj.get("cancelled") == Some(&Value::Bool(true))
}

/// Port of `slash-commands.ts`'s own `SUPPORTED_OMP_COMMANDS` table.
fn supported_omp_subcommands(name: &str) -> Option<&'static [&'static str]> {
    match name {
        "fast" => Some(&["on", "ultra", "off", "status"]),
        "slow" => Some(&["on", "off", "status"]),
        "extended-context" => Some(&["on", "off", "status"]),
        "prewalk" => Some(&["restart"]),
        "effort" => Some(&["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]),
        "dump" => Some(&["all"]),
        "todo" => Some(&["expand", "collapse", "append", "start", "done", "rm"]),
        "session" => Some(&["info"]),
        "jobs" => Some(&["full"]),
        "usage" => Some(&["show"]),
        "changelog" => Some(&["full", "last"]),
        "tools" | "context" | "fresh" | "retry" | "rename" | "add-dir" | "dirs" | "force" | "autoresearch" | "annotate" => Some(&[]),
        "shake" => Some(&["elide", "images", "thinking"]),
        _ => None,
    }
}

/// Refract's own native commands (`NATIVE_BUILT_COMMANDS`): `/new` has a working implementation
/// (`start_new_conversation`); `/btw` is listed for menu parity with the Electron build but has
/// no implementation here (side chat out of scope, see this file's own header) -- `chat.send`
/// never special-cases it, so it falls through to the unknown-command refusal below if invoked.
const NATIVE_BUILT_COMMANDS: &[(&str, &str)] = &[("new", "Start a new Conversation in this Session"), ("btw", "Ask the agent a side question")];

/// Port of `slash-commands.ts`'s own `filterSupportedCommands`.
fn filter_supported_commands(raw: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = NATIVE_BUILT_COMMANDS.iter().map(|(name, description)| json!({ "name": name, "description": description })).collect();
    for command in raw {
        let Some(name) = command.get("name").and_then(Value::as_str) else { continue };
        let Some(allowed) = supported_omp_subcommands(name) else { continue };
        let mut pruned = command.clone();
        if let Some(subs) = command.get("subcommands").and_then(Value::as_array) {
            let filtered: Vec<Value> =
                subs.iter().filter(|sub| sub.get("name").and_then(Value::as_str).map(|n| allowed.contains(&n)).unwrap_or(false)).cloned().collect();
            pruned["subcommands"] = Value::Array(filtered);
        }
        out.push(pruned);
    }
    out
}

/// Port of `slash-commands.ts`'s own `parseSlashCommand`.
pub fn parse_slash_command(text: &str) -> Option<(String, String)> {
    let trimmed = text.trim_start();
    let body = trimmed.strip_prefix('/')?;
    let space_idx = body.find(char::is_whitespace);
    let name = match space_idx {
        Some(idx) => &body[..idx],
        None => body,
    };
    if name.is_empty() {
        return None;
    }
    let rest = match space_idx {
        Some(idx) => body[idx + 1..].trim().to_string(),
        None => String::new(),
    };
    Some((name.to_string(), rest))
}

/// Port of `slash-commands.ts`'s own `SlashInvocationClassification`/`classifySlashInvocation`.
pub enum SlashInvocationClassification {
    Supported,
    UnknownCommand,
    UnsupportedArguments,
}

pub fn classify_slash_invocation(name: &str, rest: &str, commands: &[Value]) -> SlashInvocationClassification {
    let descriptor = commands.iter().find(|c| {
        c.get("name").and_then(Value::as_str) == Some(name)
            || c.get("aliases").and_then(Value::as_array).map(|a| a.iter().any(|v| v.as_str() == Some(name))).unwrap_or(false)
    });
    let Some(descriptor) = descriptor else { return SlashInvocationClassification::UnknownCommand };
    if rest.is_empty() {
        return SlashInvocationClassification::Supported;
    }
    let space_idx = rest.find(' ');
    let sub_name = match space_idx {
        Some(idx) => &rest[..idx],
        None => rest,
    };
    let extra = match space_idx {
        Some(idx) => rest[idx + 1..].trim(),
        None => "",
    };
    if !extra.is_empty() {
        return SlashInvocationClassification::UnsupportedArguments;
    }
    let supported = descriptor
        .get("subcommands")
        .and_then(Value::as_array)
        .map(|subs| subs.iter().any(|s| s.get("name").and_then(Value::as_str) == Some(sub_name)))
        .unwrap_or(false);
    if supported {
        SlashInvocationClassification::Supported
    } else {
        SlashInvocationClassification::UnsupportedArguments
    }
}
