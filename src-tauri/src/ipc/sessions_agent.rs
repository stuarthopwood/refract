// IPC handlers for the agent-backed `sessions.*` subset. Dispatches into the live
// `SessionManager` in `AppState`. Registry-only `.list`/`.create`/`.rename` live in `sessions_lifecycle.rs`.
//
// `ResumableAgent`/`AttachableAgent` keep resume and attach unit-testable against a fake agent.
// Registry glue stays in the IPC handlers, which adapt the real agent and `AppState` to each trait.

use std::collections::HashSet;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

use serde_json::Value;

use crate::session::termination::TerminationDetectionResult;
use crate::session::{AgentError, SessionAgent, SessionStatus};

use super::{invalid_argument, not_found, AppState, Dispatcher, HandlerFuture};

pub fn register(d: &mut Dispatcher) {
    d.register("sessions.open", sessions_open);
    d.register("sessions.stopAgent", sessions_stop_agent);
    d.register("sessions.setVisible", sessions_set_visible);
    d.register("sessions.recover", sessions_recover);
    d.register("sessions.resume", sessions_resume);
    d.register(
        "sessions.keepWaitingForStart",
        sessions_keep_waiting_for_start,
    );
    d.register("sessions.cancelStart", sessions_cancel_start);
}

/// Non-gating allow-list: a passive `sessions.open` never starts the agent. Unknown stop reasons fail closed.
#[cfg_attr(not(test), allow(dead_code))]
fn can_auto_start(stop_reason: Option<&str>, terminated_unexpectedly: bool) -> bool {
    let normally_allowed = matches!(
        stop_reason,
        None | Some("not-started") | Some("worktree-missing")
    );
    if !normally_allowed {
        return false;
    }
    if stop_reason != Some("worktree-missing") && terminated_unexpectedly {
        return false;
    }
    true
}

/// Resume is offered only after an unexpected termination, never for archived Sessions.
fn can_resume_session(
    status: SessionStatus,
    stop_reason: Option<&str>,
    terminated_unexpectedly: bool,
    archived: bool,
) -> bool {
    if status != SessionStatus::Stopped || archived {
        return false;
    }
    if matches!(stop_reason, Some("worktree-missing") | Some("start-failed")) {
        return false;
    }
    stop_reason == Some("agent-exited") || terminated_unexpectedly
}

/// Session-state half of the resume check; the busy half is `try_lock_resuming`.
fn check_resume_eligible(
    status: SessionStatus,
    stop_reason: Option<&str>,
    terminated_unexpectedly: bool,
    archived: bool,
) -> Option<&'static str> {
    if status != SessionStatus::Stopped {
        return Some("not-stopped");
    }
    if !can_resume_session(status, stop_reason, terminated_unexpectedly, archived) {
        return Some("not-eligible");
    }
    None
}

const RESUME_REFUSAL_MESSAGE_BUSY: &str = "Another action is already in progress for this Session.";
const RESUME_REFUSAL_MESSAGE_NOT_STOPPED: &str = "Session is not stopped.";
const RESUME_REFUSAL_MESSAGE_NOT_ELIGIBLE: &str = "Session is not eligible to resume.";

fn resume_refusal_message(code: &str) -> &'static str {
    match code {
        "busy" => RESUME_REFUSAL_MESSAGE_BUSY,
        "not-stopped" => RESUME_REFUSAL_MESSAGE_NOT_STOPPED,
        _ => RESUME_REFUSAL_MESSAGE_NOT_ELIGIBLE,
    }
}

/// Instruction sent when resuming an interrupted Session.
const DEFAULT_RESUME_INSTRUCTION: &str = "resume";

/// Shared across all resume and archive/delete calls, so the per-session lock spans IPC calls.
/// `try_lock_resuming` is `pub(crate)` so archive and delete can hold the same lock.
static RESUMING_IDS: LazyLock<StdMutex<HashSet<String>>> =
    LazyLock::new(|| StdMutex::new(HashSet::new()));

/// Claims `id` with one atomic `HashSet::insert`, so no concurrent caller can also claim it.
/// Returns `None` if busy; otherwise an RAII guard that releases the claim on drop.
pub(crate) fn try_lock_resuming(id: &str) -> Option<ResumingGuard> {
    let mut resuming = RESUMING_IDS.lock().expect("resuming_ids mutex poisoned");
    if resuming.insert(id.to_string()) {
        Some(ResumingGuard { id: id.to_string() })
    } else {
        None
    }
}

pub(crate) struct ResumingGuard {
    id: String,
}

impl Drop for ResumingGuard {
    fn drop(&mut self) {
        RESUMING_IDS
            .lock()
            .expect("resuming_ids mutex poisoned")
            .remove(&self.id);
    }
}

fn stop_reason_of(runtime: &Value) -> Option<String> {
    runtime
        .get("stopReason")
        .and_then(Value::as_str)
        .map(str::to_string)
}

// Resume (`sessions.resume`)

/// Seam for `resume_session_core`: the agent operations a resume needs.
pub(crate) trait ResumableAgent {
    async fn status(&self) -> SessionStatus;
    async fn stop_reason(&self) -> Option<String>;
    async fn resolve_termination(&self) -> TerminationDetectionResult;
    /// Re-checks archive state right before `start()`, since a concurrent archive can land mid-await.
    async fn is_archived(&self) -> bool;
    async fn start(&self) -> Result<(), AgentError>;
    async fn notify_list_changed(&self);
    /// Sends the resume instruction. Re-checks archive state first and refuses if archived.
    async fn send_resume_instruction(&self) -> Result<(), AgentError>;
}

pub(crate) enum ResumeCoreError {
    Refused(&'static str),
    PromptFailed(String),
}

/// Resume core: claims the busy lock, checks eligibility, starts, and sends the instruction.
/// The lock is claimed before the eligibility check, which closes a check-then-claim race.
pub(crate) async fn resume_session_core<A: ResumableAgent>(
    agent: &A,
    id: &str,
    archived: bool,
) -> Result<(), ResumeCoreError> {
    let Some(_guard) = try_lock_resuming(id) else {
        return Err(ResumeCoreError::Refused("busy"));
    };
    // Refuses archived Sessions before the tail read, which is expensive.
    if archived {
        return Err(ResumeCoreError::Refused("not-eligible"));
    }
    let status = agent.status().await;
    let stop_reason = agent.stop_reason().await;
    let detection = agent.resolve_termination().await;
    // Fresh archive re-check: a concurrent archive can land during the tail read above.
    if agent.is_archived().await {
        return Err(ResumeCoreError::Refused("not-eligible"));
    }
    if let Some(code) = check_resume_eligible(
        status,
        stop_reason.as_deref(),
        detection.terminated_unexpectedly,
        false,
    ) {
        return Err(ResumeCoreError::Refused(code));
    }
    let _ = agent.start().await;
    agent.notify_list_changed().await;
    if agent.status().await == SessionStatus::Stopped {
        // Never send the instruction into a Session that did not come back.
        return Ok(());
    }
    match agent.send_resume_instruction().await {
        Ok(()) => Ok(()),
        Err(err) => Err(ResumeCoreError::PromptFailed(err.message)),
    }
}

struct ResumeAgentAdapter<'a> {
    state: &'a AppState,
    agent: Arc<SessionAgent>,
    id: String,
}

impl ResumableAgent for ResumeAgentAdapter<'_> {
    async fn status(&self) -> SessionStatus {
        self.agent.status().await
    }

    async fn stop_reason(&self) -> Option<String> {
        stop_reason_of(&self.agent.runtime_view().await)
    }

    async fn resolve_termination(&self) -> TerminationDetectionResult {
        self.agent.resolve_termination().await
    }

    async fn is_archived(&self) -> bool {
        // A missing registry row counts as archived, never as not-archived.
        self.state
            .registry
            .lock()
            .await
            .get_session(&self.id)
            .is_none_or(|session| session.archived_at.is_some())
    }

    async fn start(&self) -> Result<(), AgentError> {
        // Re-checked here because the caller may have waited on the registry lock while a delete claimed the Session.
        super::sessions_lifecycle::delete_in_flight::refuse_if_deleting(&self.id)
            .map_err(|e| AgentError::new(e.code, e.message))?;
        self.agent.start().await
    }

    async fn notify_list_changed(&self) {
        self.state.session_manager.notify_list_changed();
    }

    async fn send_resume_instruction(&self) -> Result<(), AgentError> {
        // Re-check before the irreversible send; a deleted Session must never fall back to a stale copy.
        let before_send = self
            .state
            .registry
            .lock()
            .await
            .get_session(&self.id)
            .cloned();
        match before_send {
            Some(session) if session.archived_at.is_none() => {}
            _ => {
                self.agent.shutdown().await;
                return Err(AgentError::new(
                    "not-eligible",
                    "Session is not eligible to resume.",
                ));
            }
        }
        self.agent
            .send(DEFAULT_RESUME_INSTRUCTION.to_string(), None)
            .await
            .map(|_| ())
    }
}

/// `sessions.resume`: recover if needed, then send `DEFAULT_RESUME_INSTRUCTION` under the per-session lock.
pub fn sessions_resume(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(id) = args.first().and_then(Value::as_str).map(str::to_string) else {
            return Err(invalid_argument("sessions.resume expects a string id"));
        };
        super::sessions_lifecycle::delete_in_flight::refuse_if_deleting(&id)?;
        let Some(session) = state.registry.lock().await.get_session(&id).cloned() else {
            return Err(not_found(format!("Session not found: {id}")));
        };
        // Refuse archived Sessions before the tail read; `agent-exited` would otherwise pass.
        if session.archived_at.is_some() {
            return Err(invalid_argument(resume_refusal_message("not-eligible")));
        }
        let agent = state.session_manager.get_or_create_agent(&id);
        let adapter = ResumeAgentAdapter {
            state: &state,
            agent: agent.clone(),
            id: id.clone(),
        };
        let decision = resume_session_core(&adapter, &id, session.archived_at.is_some()).await;
        match decision {
            Err(ResumeCoreError::Refused(code)) => {
                Err(invalid_argument(resume_refusal_message(code)))
            }
            Err(ResumeCoreError::PromptFailed(message)) => {
                Err(super::IpcError::new("prompt-failed", message))
            }
            Ok(()) => {
                let refreshed = state
                    .registry
                    .lock()
                    .await
                    .get_session(&id)
                    .cloned()
                    .unwrap_or(session);
                Ok(super::conversations::build_snapshot(&refreshed, &agent, None).await)
            }
        }
    })
}

// Attach, open and recover

/// Seam for `attach_snapshot_decision`: the agent operations an attach needs.
pub(crate) trait AttachableAgent {
    async fn status(&self) -> SessionStatus;
    async fn resolve_termination(&self) -> TerminationDetectionResult;
    async fn start(&self) -> Result<(), AgentError>;
    async fn notify_list_changed(&self);
}

/// `force_start` restarts regardless of reason; a passive open never starts the agent.
/// Returns a fresh termination result only when the Session is `Stopped`.
pub(crate) async fn attach_snapshot_decision<A: AttachableAgent>(
    agent: &A,
    force_start: bool,
) -> Option<TerminationDetectionResult> {
    if agent.status().await != SessionStatus::Stopped {
        return None;
    }
    // A requested stop is read from memory or the persisted marker, never the tail.
    let detection = agent.resolve_termination().await;
    if force_start {
        let _ = agent.start().await;
        agent.notify_list_changed().await;
    }
    Some(detection)
}

struct AttachAgentAdapter<'a> {
    state: &'a AppState,
    id: &'a str,
    agent: Arc<SessionAgent>,
}

impl AttachableAgent for AttachAgentAdapter<'_> {
    async fn status(&self) -> SessionStatus {
        self.agent.status().await
    }

    async fn resolve_termination(&self) -> TerminationDetectionResult {
        self.agent.resolve_termination().await
    }

    async fn start(&self) -> Result<(), AgentError> {
        // Re-checked here because the caller may have waited on the registry lock while a delete claimed the Session.
        super::sessions_lifecycle::delete_in_flight::refuse_if_deleting(self.id)
            .map_err(|e| AgentError::new(e.code, e.message))?;
        self.agent.start().await
    }

    async fn notify_list_changed(&self) {
        self.state.session_manager.notify_list_changed();
    }
}

/// Shared by `sessions.open` and `sessions.recover`.
async fn attach_snapshot_core(
    state: &AppState,
    id: &str,
    force_start: bool,
) -> Result<Value, super::IpcError> {
    super::sessions_lifecycle::delete_in_flight::refuse_if_deleting(id)?;
    let Some(session) = state.registry.lock().await.get_session(id).cloned() else {
        return Err(not_found(format!("Session not found: {id}")));
    };
    let agent = state.session_manager.get_or_create_agent(id);
    if !force_start {
        agent.mark_worktree_missing_if_invalid().await;
    }
    let adapter = AttachAgentAdapter {
        state,
        id,
        agent: agent.clone(),
    };
    let detection = attach_snapshot_decision(&adapter, force_start).await;
    let refreshed = state
        .registry
        .lock()
        .await
        .get_session(id)
        .cloned()
        .unwrap_or(session);
    Ok(super::conversations::build_snapshot(&refreshed, &agent, detection.as_ref()).await)
}

/// `sessions.open`: never starts a stopped Session; `userAction` is the explicit start.
pub fn sessions_open(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(id) = args.first().and_then(Value::as_str).map(str::to_string) else {
            return Err(invalid_argument("sessions.open expects a string id"));
        };
        let user_action = args.get(1).and_then(Value::as_bool).unwrap_or(false);
        attach_snapshot_core(&state, &id, user_action).await
    })
}

/// `sessions.recover`: reattaches like `sessions.open`, but always restarts the agent.
pub fn sessions_recover(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(id) = args.first().and_then(Value::as_str).map(str::to_string) else {
            return Err(invalid_argument("sessions.recover expects a string id"));
        };
        attach_snapshot_core(&state, &id, true).await
    })
}

/// `sessions.keepWaitingForStart`: no-op unless the Session is at the `prompt` stage.
pub fn sessions_keep_waiting_for_start(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(id) = args.first().and_then(Value::as_str) else {
            return Err(invalid_argument(
                "sessions.keepWaitingForStart expects a string sessionId",
            ));
        };
        if state.registry.lock().await.get_session(id).is_none() {
            return Err(not_found(format!("Session not found: {id}")));
        }
        state
            .session_manager
            .get_or_create_agent(id)
            .keep_waiting_for_start()
            .await;
        Ok(Value::Null)
    })
}

/// `sessions.cancelStart`: no-op unless the Session is starting.
pub fn sessions_cancel_start(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(id) = args.first().and_then(Value::as_str) else {
            return Err(invalid_argument(
                "sessions.cancelStart expects a string sessionId",
            ));
        };
        if state.registry.lock().await.get_session(id).is_none() {
            return Err(not_found(format!("Session not found: {id}")));
        }
        state
            .session_manager
            .get_or_create_agent(id)
            .cancel_start()
            .await;
        Ok(Value::Null)
    })
}

/// `sessions.stopAgent`: closes stdin, waits briefly, then force-kills the process tree.
pub fn sessions_stop_agent(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(id) = args.first().and_then(Value::as_str) else {
            return Err(invalid_argument(
                "sessions.stopAgent expects a string sessionId",
            ));
        };
        if state.registry.lock().await.get_session(id).is_none() {
            return Err(not_found(format!("Session not found: {id}")));
        }
        state
            .session_manager
            .get_or_create_agent(id)
            .shutdown()
            .await;
        Ok(Value::Null)
    })
}

/// `sessions.setVisible`: accepts at most two session ids (a single pane or a split).
pub fn sessions_set_visible(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(array) = args.first().and_then(Value::as_array) else {
            return Err(invalid_argument(
                "sessions.setVisible expects an array of at most 2 session ids",
            ));
        };
        if array.len() > 2 {
            return Err(invalid_argument(
                "sessions.setVisible expects an array of at most 2 session ids",
            ));
        }
        let mut ids = Vec::with_capacity(array.len());
        for entry in array {
            let Some(id) = entry.as_str() else {
                return Err(invalid_argument(
                    "sessions.setVisible expects an array of at most 2 session ids",
                ));
            };
            ids.push(id.to_string());
        }
        state.session_manager.set_visible(ids).await;
        Ok(Value::Null)
    })
}

#[cfg(test)]
#[path = "sessions_agent.test.rs"]
mod tests;
