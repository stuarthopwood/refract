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
// Conversation first".
//
// Issue #784 ("Pre-declare per-lane Rust files") pre-declares the above scope cuts as their own
// empty sibling files -- `model.rs`, `readout.rs`, `side_chat.rs`, `start_queue.rs`,
// `subagents.rs`, `termination.rs` -- so each lane (RM, R5, R6, R3) adds its behaviour inside its
// own file only, never here: the `on_frame(agent, frame_type, &frame)`, `on_exit(agent, code,
// requested)`, and `on_start_progress(agent, stage, elapsed_ms)` calls `agent::frame`'s own
// `handle_frame` and `agent::launch`'s own `spawn_frame_listener` make per lane module, the
// lane's own `State` slot inside `AgentState` (reached only through its `with_<lane>_state`
// accessor below), and the narrow status/events/transcript/request/`session_id()` accessors
// below are the only things a lane ever needs.
//
// This module is itself split across `session/agent/` by concern (code-review finding,
// 2026-10-13: a single ~1,900-line `agent.rs` violated issue #784's own 600-line-per-file
// criterion): `mod.rs` (core state/status/transcript), `launch.rs` (start/attach/reattach),
// `frame.rs` (frame dispatch), `requests.rs` (dialog classification), `chat.rs`
// (send/stop/removeQueued), `conversations.rs` (startNew/open), `commands.rs` (slash-command
// tables), `types.rs` (`AgentError`/`PendingRequest`/`SessionStatus`, split out round 2,
// 2026-10-14, so `mod.rs` keeps headroom under its own 600-line limit). `mod agent;` in
// `session/mod.rs` still resolves here, so `crate::session::agent` and every external import of
// it are unchanged.

use std::collections::HashSet;
use std::sync::{Arc, Mutex as StdMutex, Weak};

use serde_json::{json, Value};
use tokio::sync::{watch, Mutex as AsyncMutex};

use crate::events::EventSink;
use crate::omp::diff::{diff_transcript, PatchCoalescer, TranscriptOp};
use crate::omp::process::OmpProcess;
use crate::omp::transcript::{RequestResolution, TranscriptItem, TranscriptState};
use crate::store::registry::{RegistryStore, Session};
use crate::store::settings::{ApprovalMode, SettingsStore};

mod chat;
mod commands;
mod conversations;
mod frame;
mod launch;
mod requests;
mod types;

pub use commands::{
    classify_slash_invocation, parse_slash_command, SlashInvocationClassification,
    NATIVE_RESERVED_COMMANDS,
};
pub use requests::is_chat_answer;
pub use types::{AgentError, PendingRequest, SessionStatus};

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
    // Issue #784: each lane owns its own `State` (defined in its own file), reachable only via
    // its `with_<lane>_state` accessor below; still empty/unread until a lane lands.
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
                turn_settle_handled: false,
                stop_requested: false,
                model: Default::default(),
                readout: Default::default(),
                subagents: Default::default(),
                side_chat: Default::default(),
                start_queue: Default::default(),
                termination: Default::default(),
            }),
            status_tx,
            start_lock: AsyncMutex::new(()),
            coalescer,
        })
    }

    pub(super) fn arc(&self) -> Arc<Self> {
        self.self_ref
            .upgrade()
            .expect("SessionAgent dropped while a background task still referenced it")
    }

    fn is_visible(&self) -> bool {
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

    // -----------------------------------------------------------------------------------------
    // Status / events
    // -----------------------------------------------------------------------------------------

    fn status_event_locked(&self, state: &AgentState) -> Value {
        let mut payload = json!({
            "sessionId": self.session_id,
            "status": state.status,
            "unread": state.unread,
            "launchedMode": state.launched_mode,
            "pendingMode": state.pending_mode,
        });
        let obj = payload
            .as_object_mut()
            .expect("status_event_locked payload is always a JSON object");
        // `stopReason`/`stopDetail` are TS `?:` optional fields (the renderer checks
        // `=== undefined`, ChatPane.tsx:205): omitted entirely when absent, not sent as JSON
        // `null` (code-review finding, 2026-10-13). `terminatedUnexpectedly`/`startProgress`
        // have no port in this build (see this file's own header comment) and so are never
        // emitted at all either.
        if let Some(reason) = state.stop_reason {
            obj.insert("stopReason".to_string(), Value::String(reason.to_string()));
        }
        if let Some(detail) = &state.stop_detail {
            obj.insert("stopDetail".to_string(), Value::String(detail.clone()));
        }
        payload
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

    /// Port of `exitVerdictGuard.ts`'s `shouldApplyCrashExitVerdict`'s `statusNow !== 'stopped'`
    /// half, used by `handle_exit`'s crash branch (code-review finding, 2026-10-13): a crash
    /// arriving during `launch()`'s post-spawn history fetch can race `launch()`'s own
    /// synchronous `exitedDuringStart`/`record_start_failure` write (both read/write
    /// `state.process`/`state.status` across the same await). Checking `state.status` and
    /// writing the new one inside ONE lock acquisition -- instead of a separate pre-check
    /// followed by `set_status`'s own lock -- closes the narrow window where the two writers
    /// could otherwise still interleave between check and write. TS's single-threaded
    /// `shouldApplyCrashExitVerdict` only needs the read-then-write to be atomic with respect to
    /// awaits, which this mirrors with an explicit lock. Whichever write actually lands first,
    /// this makes the final reason always `start-failed` (never `agent-exited`) for this race,
    /// matching TS: if `record_start_failure` wins the race to the lock, this call sees
    /// `Stopped` already and skips; if this call wins instead, `record_start_failure`'s own
    /// unconditional `set_status` still overwrites it right after, same final result.
    async fn set_stopped_unless_already_stopped(
        &self,
        stop_reason: &'static str,
        stop_detail: Option<String>,
    ) {
        {
            let mut state = self.state.lock().await;
            if state.status == SessionStatus::Stopped {
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
        // Gate-fix (HIGH, correctness): computed BEFORE the `state.lock()` below, never while
        // holding it -- `current_selection` can lazily seed `current_role` from the Session's
        // own Conversation file the first time this runs (#741: never a guessed `"default"`),
        // which needs its own `with_model_state` lock acquisition; calling it while already
        // holding `state.lock()` here would deadlock (the same `tokio::sync::Mutex`, not
        // reentrant).
        let (pinned, current_role) = crate::session::model::current_selection(self).await;
        let state = self.state.lock().await;
        let mut payload = json!({
            "status": state.status,
            "unread": state.unread,
            "launchedMode": state.launched_mode,
            "pendingMode": state.pending_mode,
            // Issue #740/#741 (lane RM): role chip/pin state on every `sessions.list()` row.
            // `current_role` is `None` (-> JSON `null`) when truly unknown, never a guess.
            "currentRole": if pinned { Value::Null } else {
                match current_role {
                    Some(role) => Value::String(role),
                    None => Value::Null,
                }
            },
            "pinned": pinned,
        });
        if let Some(reason) = state.stop_reason {
            payload
                .as_object_mut()
                .expect("summary_fields payload is always a JSON object")
                .insert("stopReason".to_string(), Value::String(reason.to_string()));
        }
        payload
    }

    /// `SessionRuntimeView` (`sessions.open`/`.recover`/`conversations.startNew`/`.open`'s own
    /// `SessionSnapshot.runtime`).
    pub async fn runtime_view(&self) -> Value {
        let state = self.state.lock().await;
        let mut payload = json!({
            "sessionId": self.session_id,
            "status": state.status,
            "unread": state.unread,
            "launchedMode": state.launched_mode,
            "pendingMode": state.pending_mode,
            // `SessionRuntimeView` (`src/shared/ipc.ts`) requires all three of these: the
            // renderer's `ChatPane`/`Transcript` components read `runtime.transcript`/`.queue`/
            // `.pending` unconditionally (no optional-chaining fallback) the moment a Session
            // pane opens, so an omitted field here throws under the renderer's own ErrorBoundary
            // ("Something went wrong rendering this view") the instant `sessions.open` resolves,
            // before any turn even runs. Fixed live (tasks.md T032 verification, first Session
            // ever opened in this build).
            "transcript": state.transcript.items(),
            "queue": { "followUp": state.queue_follow_up, "steering": state.queue_steering },
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
        payload
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
        state.transcript.apply_frame(frame);
        let ops = diff_transcript(&before, state.transcript.items());
        // Queued while still holding `state.lock()` (code-review finding, 2026-10-13): otherwise
        // a concurrent `emit_patch_reset` (`SessionManager::set_visible`) can slip its own
        // `Reset` into the coalescer between this diff and this queue call, and the reset would
        // then supersede (drop) this upsert even though it is the newer change.
        if !ops.is_empty() {
            self.coalescer.queue(ops);
        }
    }

    async fn append_notice(&self, text: String, level: &str) {
        self.apply_transcript_frame(&json!({ "type": "notice", "level": level, "message": text }))
            .await;
    }

    /// Port of `SessionAgent.ts`'s `upsertTranscriptItem` for `kind: 'request'` rows
    /// (`addPendingRequest` and `resolvePendingRequest`). The renderer draws an approval or
    /// question card only from these rows, joined with the live pending list (`Transcript.tsx`).
    async fn upsert_request_row(&self, request_id: &str, resolved: Option<RequestResolution>) {
        self.upsert_transcript_item(TranscriptItem::Request {
            id: format!("request:{request_id}"),
            request_id: request_id.to_string(),
            resolved,
        })
        .await;
    }

    /// Full-snapshot flush (`PatchCoalescer`'s `reset` semantics: "reset supersedes queue"),
    /// used at the end of `launch()`/`start_new_conversation()`/`open_conversation()`, and by
    /// `session::manager::SessionManager::set_visible` for a Session that just became visible
    /// (its patches were dropped by the coalescer's own visibility gate while hidden). Skips
    /// queuing entirely for a hidden Session (performance finding, 2026-10-13): the flush
    /// closure's own `visible_ids` gate would drop the patch anyway, so there is no reason to
    /// even clone the `Arc` pointers for it. `set_visible` always calls this AFTER it has
    /// already added the Session to `visible_ids`, so the one call that must fire -- the
    /// newly-visible catch-up snapshot -- still passes this check.
    pub async fn emit_patch_reset(&self) {
        if !self.is_visible() {
            return;
        }
        let state = self.state.lock().await;
        let items: Vec<Arc<TranscriptItem>> = state.transcript.items().to_vec();
        self.coalescer.queue(vec![TranscriptOp::Reset { items }]);
        drop(state);
        self.coalescer.flush_now();
    }

    // -----------------------------------------------------------------------------------------
    // Lane extension points (state slot + narrow accessors; see "Lane extension contract" above)
    // -----------------------------------------------------------------------------------------

    // `#[allow(dead_code)]` below: unread until a lane's `on_frame` calls it (all are no-ops).
    #[allow(dead_code)]
    pub(super) fn events(&self) -> &EventSink {
        &self.events
    }

    /// Narrow accessor so a lane can build its own per-session event payload (for example
    /// `{"sessionId": agent.session_id(), ...}` before calling `agent.events().send(...)`)
    /// without reaching into `SessionAgent`'s private `session_id` field.
    #[allow(dead_code)]
    pub(super) fn session_id(&self) -> &str {
        &self.session_id
    }

    /// Generic transcript upsert a lane can call from its own `on_frame`, the same sequence
    /// `upsert_request_row` above factors through for its own `kind: 'request'` rows.
    pub(super) async fn upsert_transcript_item(&self, item: TranscriptItem) {
        let mut state = self.state.lock().await;
        let before = state.transcript.items().to_vec();
        state.transcript.upsert_item(item);
        let ops = diff_transcript(&before, state.transcript.items());
        if !ops.is_empty() {
            self.coalescer.queue(ops);
        }
    }

    /// Registers a pending request the same way `handle_frame`'s own `DialogClassification::
    /// Request` arm used to inline (code-review finding, 2026-10-14): pushes onto
    /// `state.pending`, moves the Session to `NeedsYou`, upserts the transcript `kind: 'request'`
    /// row (`upsert_request_row`), and emits `request:pending` -- the full sequence in one call,
    /// so a lane can register its own pending request the same way `frame.rs` does.
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

    /// Generic RPC passthrough for a lane module (lane RM's `session::model`): same
    /// `state.process.clone()` + error mapping as `chat.rs`'s own `send()`. No idle check of
    /// its own -- see `request_rpc_if_idle` below for the atomic version every lane call that
    /// changes the model/role now uses instead (gate-fix, HIGH: the old two-step "check idle,
    /// then call this" had a race window a concurrent turn start could land in).
    pub(super) async fn request_rpc(
        &self,
        cmd: Value,
        timeout_ms: u64,
    ) -> Result<Value, AgentError> {
        let proc = {
            let state = self.state.lock().await;
            state.process.clone().ok_or_else(|| {
                AgentError::new(
                    "agent-not-running",
                    format!(
                        "SessionAgent {}: cannot send, no live process",
                        self.session_id
                    ),
                )
            })?
        };
        proc.request(cmd, timeout_ms)
            .await
            .map_err(|err| AgentError::new("prompt-failed", err.to_string()))
    }

    /// Gate-fix (HIGH, race): the atomic form `request_rpc` itself cannot be -- checking
    /// `state.status` and cloning `state.process` happen under the SAME lock acquisition here,
    /// so nothing can start a turn between "confirmed idle" and "process handle taken". Refuses
    /// with `not-idle` (never queues) if the Session is working at that exact instant. Lane RM's
    /// `set_model`/`cycle_model` use this for every RPC that changes the live model.
    pub(super) async fn request_rpc_if_idle(
        &self,
        cmd: Value,
        timeout_ms: u64,
        refusal_message: &str,
    ) -> Result<Value, AgentError> {
        let proc = {
            let state = self.state.lock().await;
            if matches!(
                state.status,
                SessionStatus::Working | SessionStatus::NeedsYou
            ) {
                return Err(AgentError::new(
                    "not-idle",
                    format!("{refusal_message} after the current turn."),
                ));
            }
            state.process.clone().ok_or_else(|| {
                AgentError::new(
                    "agent-not-running",
                    format!(
                        "SessionAgent {}: cannot send, no live process",
                        self.session_id
                    ),
                )
            })?
        };
        proc.request(cmd, timeout_ms)
            .await
            .map_err(|err| AgentError::new("prompt-failed", err.to_string()))
    }

    /// `send()`'s own atomic-idle sibling (gate-fix, HIGH, race): `send()` itself always allows
    /// a mid-turn call to queue as a follow-up (`streamingBehavior`), which is exactly what lane
    /// RM's own `/switch`/`/role` text commands must never do (constitution-level refusal, not
    /// queuing). Checks `state.status` and takes `state.process`/marks-user-acted under the
    /// SAME lock acquisition, so nothing can start a turn in the gap, then sends a plain `prompt`
    /// with no `streamingBehavior` field at all (this path only ever runs while idle).
    pub(super) async fn send_if_idle(
        &self,
        text: String,
        images: Option<Vec<Value>>,
    ) -> Result<Value, AgentError> {
        let proc = {
            let mut state = self.state.lock().await;
            if matches!(
                state.status,
                SessionStatus::Working | SessionStatus::NeedsYou
            ) {
                return Err(AgentError::new(
                    "not-idle",
                    "Switch the model after the current turn.",
                ));
            }
            state.transcript.mark_user_acted();
            state.process.clone().ok_or_else(|| {
                AgentError::new(
                    "agent-not-running",
                    format!(
                        "SessionAgent {}: cannot send, no live process",
                        self.session_id
                    ),
                )
            })?
        };
        let mut cmd = json!({ "type": "prompt", "message": text });
        if let Some(images) = images {
            if !images.is_empty() {
                cmd["images"] = Value::Array(images);
            }
        }
        let res = proc
            .request(cmd, DEFAULT_REQUEST_TIMEOUT_MS)
            .await
            .map_err(|err| AgentError::new("prompt-failed", err.to_string()))?;
        if res.get("success").and_then(Value::as_bool) != Some(true) {
            let err_message = res
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
                .to_string();
            return Err(AgentError::new(
                "prompt-failed",
                format!("prompt failed: {err_message}"),
            ));
        }
        Ok(json!({ "queued": false }))
    }

    /// Gate-fix (HIGH, race, #740): atomically decides whether a Settings-triggered role reapply
    /// must be queued (the Session is working right now) or can run immediately -- the old code
    /// read `status()` and wrote `pending_role_reapply` as two SEPARATE lock acquisitions, so a
    /// settle landing between them lost the reapply until the Session's NEXT turn ended (which
    /// then ran on the stale model). Returns `true` when queued (nothing further to do here;
    /// `on_frame`'s own settle hook applies it later), `false` when the Session was idle at this
    /// exact instant (the caller must call `apply_role_now` itself right away).
    pub(super) async fn queue_role_reapply_or_ready(&self, role: &str) -> bool {
        let mut state = self.state.lock().await;
        if matches!(
            state.status,
            SessionStatus::Working | SessionStatus::NeedsYou
        ) {
            state.model.pending_role_reapply = Some(role.to_string());
            true
        } else {
            false
        }
    }

    /// The Session's own current Conversation file path, if any (registry lookup; #741: reading
    /// its latest `model_change` role needs this). `None` for a brand-new Session that has never
    /// sent its first message.
    pub(super) async fn current_conversation_path(&self) -> Option<String> {
        self.registry
            .lock()
            .await
            .get_session(&self.session_id)?
            .current_conversation
            .clone()
    }

    /// Re-reads `get_state`, applies it via `sync_from_state`, and returns the raw `data`
    /// object (FINDINGS item 30: `model = {provider, id, name?}`) so a lane (RM's own
    /// `set_model`/`cycle_model`/role switch) can refresh the composer label/notice itself.
    /// Best-effort: failures are non-fatal to the caller.
    pub(super) async fn refresh_from_state(&self) -> Result<Value, AgentError> {
        let res = self
            .request_rpc(json!({ "type": "get_state" }), DEFAULT_REQUEST_TIMEOUT_MS)
            .await?;
        if res.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(AgentError::new("prompt-failed", "get_state failed"));
        }
        let data = res.get("data").cloned().unwrap_or(Value::Null);
        self.sync_from_state(&data).await;
        Ok(data)
    }

    #[allow(dead_code)]
    pub(super) async fn with_model_state<R>(
        &self,
        f: impl FnOnce(&mut crate::session::model::State) -> R,
    ) -> R {
        f(&mut self.state.lock().await.model)
    }

    #[allow(dead_code)]
    pub(super) async fn with_readout_state<R>(
        &self,
        f: impl FnOnce(&mut crate::session::readout::State) -> R,
    ) -> R {
        f(&mut self.state.lock().await.readout)
    }

    #[allow(dead_code)]
    pub(super) async fn with_subagents_state<R>(
        &self,
        f: impl FnOnce(&mut crate::session::subagents::State) -> R,
    ) -> R {
        f(&mut self.state.lock().await.subagents)
    }

    #[allow(dead_code)]
    pub(super) async fn with_side_chat_state<R>(
        &self,
        f: impl FnOnce(&mut crate::session::side_chat::State) -> R,
    ) -> R {
        f(&mut self.state.lock().await.side_chat)
    }

    #[allow(dead_code)]
    pub(super) async fn with_start_queue_state<R>(
        &self,
        f: impl FnOnce(&mut crate::session::start_queue::State) -> R,
    ) -> R {
        f(&mut self.state.lock().await.start_queue)
    }

    #[allow(dead_code)]
    pub(super) async fn with_termination_state<R>(
        &self,
        f: impl FnOnce(&mut crate::session::termination::State) -> R,
    ) -> R {
        f(&mut self.state.lock().await.termination)
    }
}
