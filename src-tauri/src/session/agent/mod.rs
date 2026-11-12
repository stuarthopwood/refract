// One agent per opened Session; split by concern across `session/agent/`.

use std::collections::HashSet;
use std::sync::{Arc, Mutex as StdMutex, Weak};

use serde_json::{json, Value};
use tokio::sync::{watch, Mutex as AsyncMutex, Notify};

use crate::events::EventSink;
use crate::omp::diff::{diff_transcript, PatchCoalescer, TranscriptOp};
use crate::omp::process::OmpProcess;
use crate::omp::transcript::subagent_items::ProgressOutcome;
use crate::omp::transcript::{RequestResolution, TranscriptItem, TranscriptState};
use crate::store::registry::{RegistryStore, Session};
use crate::store::settings::{ApprovalMode, SettingsStore};

mod chat;
mod chat_restore;
mod command_wait;
mod commands;
mod conversations;
mod frame;
mod handoff;
mod lane_support;
mod launch;
mod launch_support;
pub mod pause;
mod pause_subagents;
mod requests;
mod status;
mod sync_from_state;
mod tool_host;
mod types;
pub use command_wait::COMMANDS_WAIT;
pub use commands::{
    classify_slash_invocation, classify_unsupported_arguments, parse_slash_command,
    SlashInvocationClassification, SubcommandRefusal, NATIVE_RESERVED_COMMANDS,
};
pub use requests::is_chat_answer;
use types::should_apply_crash_exit_verdict;
pub use types::{AgentError, AskOption, AskQuestion, PendingRequest, SessionStatus};

/// Same value as `omp::process`'s private request timeout.
const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 60_000;
/// Upper bound on waiting for an aborted turn to settle.
const ABORT_SETTLE_TIMEOUT_MS: u64 = 60_000;
/// Page size when fetching the full message history.
const MESSAGES_PAGE_SIZE: u64 = 200;
/// Safety cap on pages fetched, so a bad cursor cannot loop forever.
const MAX_MESSAGE_PAGES: u32 = 10_000;
/// Caps model-supplied string fields so an oversized value cannot bloat the transcript.
const MAX_MODEL_FIELD_LENGTH: usize = 256;

pub type SharedRegistry = Arc<AsyncMutex<RegistryStore>>;
pub type SharedSettings = Arc<AsyncMutex<SettingsStore>>;

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
    // Set by `ask_dialog` (#572).
    #[allow(dead_code)]
    ask_dialog_enabled: bool,
    // Even while settled, so a reset can never be mistaken for an in-flight turn.
    turn_generation: u64,
    stop_requested: bool,
    shutdown_generation: u64,
    turn_abort_requested: bool, // issue #911: true while `chat.stop`'s own `abort` RPC is in flight for this turn
    // Each lane owns its own state slot, reached via its `with_<lane>_state` accessor.
    advisor: crate::session::advisor::State,
    #[allow(dead_code)]
    model: crate::session::model::State,
    #[allow(dead_code)]
    readout: crate::session::readout::State,
    #[allow(dead_code)]
    subagents: crate::session::subagents::State,
    #[allow(dead_code)]
    side_chat: crate::session::side_chat::State,
    #[allow(dead_code)]
    start_queue: crate::session::start_queue::State,
    #[allow(dead_code)]
    termination: crate::session::termination::State,
    token_guard: crate::session::token_guard::State,
    working_mode: crate::session::working_mode::State,
    pause: pause::State,
}

/// One per opened Session.
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
    /// Woken each time OMP reports its commands, for `wait_for_commands` (#1812).
    commands_reported: Notify,
    coalescer: PatchCoalescer,
    agent_tools: crate::agent_tools::router::ToolRouter,
}

/// Generates one `with_<lane>_state` accessor per lane.
macro_rules! with_lane_state {
    ($name:ident, $field:ident, $state:path) => {
        #[allow(dead_code)]
        pub(super) async fn $name<R>(&self, f: impl FnOnce(&mut $state) -> R) -> R {
            f(&mut self.state.lock().await.$field)
        }
    };
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
                // A hidden Session's patches are computed but not forwarded.
                if !flush_visible_ids
                    .lock()
                    .expect("visible_ids mutex poisoned")
                    .contains(&flush_session_id)
                {
                    return;
                }
                flush_events.emit_transcript_patch(&flush_session_id, &ops);
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
                ask_dialog_enabled: false,
                turn_generation: 1, // odd/"not yet settled", not 0 (gate-fix #856)
                stop_requested: false,
                shutdown_generation: 0,
                turn_abort_requested: false,
                advisor: Default::default(),
                model: Default::default(),
                readout: Default::default(),
                subagents: Default::default(),
                side_chat: Default::default(),
                start_queue: Default::default(),
                termination: Default::default(),
                token_guard: Default::default(),
                working_mode: Default::default(),
                pause: Default::default(),
            }),
            status_tx,
            start_lock: AsyncMutex::new(()),
            commands_reported: Notify::new(),
            agent_tools: Default::default(),
            coalescer,
        })
    }

    /// `pub(super)` so the cancel watcher can hold it across `tokio::spawn`.
    pub(super) fn arc(&self) -> Arc<Self> {
        self.self_ref
            .upgrade()
            .expect("SessionAgent dropped while a background task still referenced it")
    }

    pub(super) fn is_visible(&self) -> bool {
        self.visible_ids
            .lock()
            .expect("visible_ids mutex poisoned")
            .contains(&self.session_id)
    }

    async fn require_session(&self) -> Result<Session, AgentError> {
        self.registry
            .lock()
            .await
            .get_session(&self.session_id)
            .cloned()
            .ok_or_else(|| {
                AgentError::new(
                    "not-found",
                    format!(
                        "SessionAgent {}: session not found in registry",
                        self.session_id
                    ),
                )
            })
    }

    /// Needs the registry row to record and clear the termination marker.
    pub(super) fn registry(&self) -> &SharedRegistry {
        &self.registry
    }

    /// Lets `shutdown()` abort a `start()` that is still waiting for a slot.
    pub(super) async fn stop_requested(&self) -> bool {
        self.state.lock().await.stop_requested
    }

    /// A deliberate stop during a start ends as `stopped`, not `start-failed`.
    pub(super) async fn mark_stopped_not_started(&self) {
        self.set_status(SessionStatus::Stopped, Some("not-started"), None)
            .await;
    }

    pub(super) async fn emit_status(&self) {
        self.ensure_pause_loaded().await;
        crate::session::working_mode::ensure_loaded(self).await;
        let state = self.state.lock().await;
        let payload = self.status_event_locked(&state);
        drop(state);
        self.events.emit_session_status(&payload);
    }

    /// Becomes `unread` only on `working` -> `idle` while the Session is hidden.
    pub(super) async fn set_status(
        &self,
        status: SessionStatus,
        stop_reason: Option<&'static str>,
        stop_detail: Option<String>,
    ) {
        {
            let mut state = self.state.lock().await;
            let became_unread = state.status == SessionStatus::Working
                && status == SessionStatus::Idle
                && !self.is_visible();
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

    /// Check and write under one lock, so a racing start cannot interleave.
    async fn set_stopped_unless_already_stopped(
        &self,
        stop_reason: &'static str,
        stop_detail: Option<String>,
    ) {
        {
            let mut state = self.state.lock().await;
            if !should_apply_crash_exit_verdict(state.status) {
                return;
            }
            if state.status == SessionStatus::Working && !self.is_visible() {
                state.unread = true;
            }
            state.status = SessionStatus::Stopped;
            state.stop_reason = Some(stop_reason);
            state.stop_detail = stop_detail;
            let _ = self.status_tx.send(SessionStatus::Stopped);
        }
        self.emit_status().await;
    }

    /// Clears `unread` once the Session becomes visible.
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

    /// Includes `startProgress`, so an unrelated refresh does not wipe the notice.
    pub async fn summary_fields(&self) -> Value {
        let (current_role, pinned) = self.role_summary_fields().await;
        let pending_selection = crate::session::pending_selection::wire(self).await;
        self.ensure_pause_loaded().await;
        crate::session::working_mode::ensure_loaded(self).await;
        let state = self.state.lock().await;
        let mut payload = json!({
            "status": state.status,
            "unread": state.unread,
            "launchedMode": state.launched_mode,
            "pendingMode": state.pending_mode,
            "currentRole": current_role, "pinned": pinned,
        });
        let object = payload
            .as_object_mut()
            .expect("summary_fields payload is always a JSON object");
        if let Some(pending) = pending_selection {
            object.insert("pendingSelection".to_string(), pending);
        }
        if let Some(reason) = state.stop_reason {
            object.insert("stopReason".to_string(), Value::String(reason.to_string()));
        }
        if let Some(progress) = state.start_queue.to_wire() {
            object.insert("startProgress".to_string(), progress);
        }
        if let Some(pause) = pause::wire_value(&state) {
            object.insert("pause".to_string(), pause.into());
        }
        state.working_mode.insert_wire(object);
        payload
    }

    /// Shape the renderer requires when a Session pane opens.
    pub async fn runtime_view(&self) -> Value {
        self.ensure_pause_loaded().await;
        crate::session::working_mode::ensure_loaded(self).await;
        let state = self.state.lock().await;
        let mut payload = json!({
            "sessionId": self.session_id,
            "status": state.status,
            "unread": state.unread,
            "launchedMode": state.launched_mode,
            "pendingMode": state.pending_mode,
            // The renderer reads these three unconditionally.
            "transcript": state.transcript.items(),
            "queue": { "followUp": pause::queue_view(&state, &state.queue_follow_up, &state.queue_steering).0, "steering": state.queue_steering },
            "pending": state.pending,
        });
        let obj = payload
            .as_object_mut()
            .expect("runtime_view payload is always a JSON object");
        if let Some(reason) = state.stop_reason {
            obj.insert("stopReason".to_string(), Value::String(reason.to_string()));
        }
        if let Some(detail) = &state.stop_detail {
            obj.insert("stopDetail".to_string(), Value::String(detail.clone()));
        }
        Self::insert_termination_and_progress_fields(obj, &state);
        payload
    }

    async fn apply_transcript_frame(&self, frame: &Value) {
        let mut state = self.state.lock().await;
        self.apply_frame_locked(&mut state, frame);
    }

    /// For a caller that checks state and writes the transcript in one lock hold.
    fn apply_frame_locked(&self, state: &mut AgentState, frame: &Value) {
        let before = state.transcript.snapshot();
        let turn_abort_requested = state.turn_abort_requested;
        state.transcript.apply_frame(frame, turn_abort_requested);
        let ops = diff_transcript(&before, state.transcript.items());
        // Queued under the state lock so a concurrent reset cannot supersede this upsert.
        if !ops.is_empty() {
            self.coalescer.queue(ops);
        }
    }

    async fn append_notice(&self, text: String, level: &str) {
        self.apply_transcript_frame(&json!({ "type": "notice", "level": level, "message": text }))
            .await;
    }

    /// Upserts a `kind: 'request'` row; the renderer draws approval cards from these.
    async fn upsert_request_row(&self, request_id: &str, resolved: Option<RequestResolution>) {
        self.upsert_transcript_item(TranscriptItem::Request {
            id: format!("request:{request_id}"),
            request_id: request_id.to_string(),
            resolved,
        })
        .await;
    }

    /// Full-snapshot flush; hidden Sessions skip queuing.
    pub async fn emit_patch_reset(&self) {
        if !self.is_visible() {
            return;
        }
        let state = self.state.lock().await;
        let items: Vec<Arc<TranscriptItem>> = state.transcript.snapshot();
        self.coalescer.queue(vec![TranscriptOp::Reset { items }]);
        drop(state);
        self.coalescer.flush_now();
    }

    // Lanes reach the agent only through these accessors.
    #[allow(dead_code)]
    pub(super) fn events(&self) -> &EventSink {
        &self.events
    }

    /// Session id for building a lane's own event payload.
    #[allow(dead_code)]
    pub(super) fn session_id(&self) -> &str {
        &self.session_id
    }

    /// Live process handle, for pid and latency reads.
    pub(super) async fn process_handle(&self) -> Option<Arc<OmpProcess>> {
        self.state.lock().await.process.clone()
    }

    /// Generic transcript upsert for a lane's own `on_frame`.
    pub(super) async fn upsert_transcript_item(&self, item: TranscriptItem) {
        let mut state = self.state.lock().await;
        let before = state.transcript.snapshot();
        state.transcript.upsert_item(item);
        let ops = diff_transcript(&before, state.transcript.items());
        if !ops.is_empty() {
            self.coalescer.queue(ops);
        }
    }

    /// Settles matching running `subagent` rows in one diff, so the chain row follows the Agents
    /// summaries (#1437). Each entry is `(tool_call_id, spec_index, outcome, duration_ms)`.
    pub(super) async fn settle_transcript_subagents(
        &self,
        settles: &[(String, u32, ProgressOutcome, Option<i64>)],
    ) {
        if settles.is_empty() {
            return;
        }
        let mut state = self.state.lock().await;
        let before = state.transcript.snapshot();
        for (tool_call_id, spec_index, outcome, duration_ms) in settles {
            state
                .transcript
                .settle_subagent(tool_call_id, *spec_index, *outcome, *duration_ms);
        }
        let ops = diff_transcript(&before, state.transcript.items());
        if !ops.is_empty() {
            self.coalescer.queue(ops);
        }
    }

    /// Registers a pending request: queue, `NeedsYou`, transcript row and event in one call.
    pub(super) async fn push_pending_request(&self, request: PendingRequest) {
        let payload =
            serde_json::to_value(&request).expect("PendingRequest is always JSON-serialisable");
        let request_id = request.request_id().to_string();
        {
            let mut state = self.state.lock().await;
            state.pending.push(request);
        }
        self.set_status(SessionStatus::NeedsYou, None, None).await;
        self.upsert_request_row(&request_id, None).await;
        self.events.emit_request_pending(&self.session_id, &payload);
    }

    // Generated by one macro; the accessors differ only by field and type.
    with_lane_state!(with_advisor_state, advisor, crate::session::advisor::State);
    with_lane_state!(with_model_state, model, crate::session::model::State);
    with_lane_state!(with_readout_state, readout, crate::session::readout::State);
    with_lane_state!(
        with_subagents_state,
        subagents,
        crate::session::subagents::State
    );
    with_lane_state!(
        with_side_chat_state,
        side_chat,
        crate::session::side_chat::State
    );
    with_lane_state!(
        with_start_queue_state,
        start_queue,
        crate::session::start_queue::State
    );
    with_lane_state!(
        with_termination_state,
        termination,
        crate::session::termination::State
    );
    with_lane_state!(
        with_token_guard_state,
        token_guard,
        crate::session::token_guard::State
    );
    with_lane_state!(
        with_working_mode_state,
        working_mode,
        crate::session::working_mode::State
    );
}
