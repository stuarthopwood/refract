// IPC handlers for the agent-backed `sessions.*` subset (contracts/ipc.md "Sessions", tasks.md
// T024/T036/T037/T040): `.open`/`.stopAgent`/`.setVisible` (Phase 3) dispatch into the live
// `session::SessionManager` `AppState::session_manager` carries. Lane R3 (issue #786) adds
// `.recover`, `.resume`, `.keepWaitingForStart`, `.cancelStart` -- the four channels that were
// `unsupported` (FR-007) before this lane landed -- plus real `terminatedUnexpectedly`-aware
// auto-start for `.open`, replacing this file's own earlier simplification (see `session::agent`'s
// header for the "always false" placeholder this lane removes).
//
// Split from the former `ipc/sessions.rs` (issue #784, "Pre-declare per-lane Rust files") so
// lane R3 (#786, agent start/recovery/resume as a typed state machine) is the only lane that
// ever edits this file; the registry-only `.list`/`.create`/`.rename` arms live in the sibling
// `ipc/sessions_lifecycle.rs` instead (lane R2, #785).
//
// `ResumableAgent`/`AttachableAgent` (gate-fix, code review + test-review HIGH): the 2-5
// operations `resume_session_core`/`attach_snapshot_decision` need, abstracted so both are
// unit-testable against a plain fake -- port of `resumeSession.ts`'s own `ResumableAgent` and
// `attachSnapshot.ts`'s own `AttachableAgent` interfaces. The registry-specific glue neither
// trait knows about (reading/re-reading the `Session` row, building the real `SessionSnapshot`)
// stays in the IPC handlers themselves (`sessions_resume`/`attach_snapshot_core`), which adapt
// the real `Arc<SessionAgent>` + `AppState` to each trait.

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

/// Port of `ipc/canAutoStart.ts`: an allow-list (never a deny-list), so a future, unrecognised
/// `stopReason` fails CLOSED (stays stopped) rather than auto-starting into whatever that new
/// state turns out to mean. `agent-exited`/`start-failed` must never auto-start (FR-034): the
/// crashed/failed agent stays visibly stopped until the user explicitly asks `sessions.recover`.
/// A `not-started`/absent Session whose Conversation tail shows it died mid-turn is excluded too
/// (issue #509 requirement 6), so opening it never silently auto-starts past the chance to
/// Resume with the default instruction before the stop banner ever shows. `worktree-missing` is
/// exempt from that extra exclusion: its own dedicated Recreate/Archive/Delete actions apply
/// regardless of what the tail happens to show.
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

/// Port of `src/shared/canResumeSession.ts`: shown/allowed only when the agent was terminated
/// unexpectedly -- `agent-exited` this run, or a persisted (file-tail) `terminatedUnexpectedly`
/// signal for a Session that died mid-turn in an earlier run. Never for `worktree-missing` (its
/// own dedicated actions) or `start-failed` (out of scope until #449 is fully landed), and never
/// for an archived Session.
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

/// Port of `resumeEligibility.ts`'s own `checkResumeEligible`, narrowed to the Session-state half
/// (`not-stopped`/`not-eligible`): the `busy` half is `try_lock_resuming`'s own job now
/// (gate-fix, security review HIGH -- see that function's own doc comment for the TOCTOU window
/// a separate `resuming_ids.contains()` check-then-later-`insert()` pair left open).
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

/// Port of `src/shared/model.ts`'s own `DEFAULT_RESUME_INSTRUCTION`.
const DEFAULT_RESUME_INSTRUCTION: &str = "resume";

/// Port of `resumeSession.ts`'s own `resumingIds`: one `Set` shared across every
/// `sessions.resume` call for the life of the app, so the per-session lock genuinely spans
/// concurrent IPC calls, not just one function's own stack frame. Issue #603 quality-gate
/// follow-up: `sessions.archive`/`.delete` (`ipc::sessions_lifecycle`, lane R2) are meant to hold
/// this SAME lock set for their own shutdown()+write duration, not just a resume in progress --
/// `try_lock_resuming` below is exposed (`pub(crate)`) for exactly that.
static RESUMING_IDS: LazyLock<StdMutex<HashSet<String>>> =
    LazyLock::new(|| StdMutex::new(HashSet::new()));

/// Claims `id` in the shared busy-lock set with ONE atomic `HashSet::insert` call (gate-fix,
/// security review HIGH): `insert` itself returns whether the value was newly added, so the
/// eligibility check and the claim are a single lock acquisition with no window between them for
/// a second concurrent caller to also see "not yet claimed" and also proceed -- the TOCTOU a
/// separate `contains()`-then-later-`insert()` pair left open under a real multi-threaded tokio
/// runtime (two OS threads can genuinely run each call's own check/insert in parallel, not just
/// interleaved cooperative scheduling). Returns `None` (busy) if someone else already holds it;
/// otherwise an RAII guard that releases the claim on drop, exactly once, on every return path
/// (success, error, or panic unwind alike).
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

// -------------------------------------------------------------------------------------------
// Resume (`sessions.resume`): injectable core (gate-fix, code review + test-review HIGH)
// -------------------------------------------------------------------------------------------

/// Minimal seam `resume_session_core` needs -- port of `resumeSession.ts`'s own `ResumableAgent`.
pub(crate) trait ResumableAgent {
    async fn status(&self) -> SessionStatus;
    async fn stop_reason(&self) -> Option<String>;
    async fn resolve_termination(&self) -> TerminationDetectionResult;
    async fn start(&self) -> Result<(), AgentError>;
    async fn notify_list_changed(&self);
    /// Sends the configured resume instruction as a real turn. The real adapter also re-checks
    /// (right here, the last moment before this irreversible step) that the Session has not been
    /// archived/deleted since eligibility was checked, shutting the just-started agent back down
    /// and refusing instead of sending into a Session this call is about to report as ineligible.
    async fn send_resume_instruction(&self) -> Result<(), AgentError>;
}

pub(crate) enum ResumeCoreError {
    Refused(&'static str),
    PromptFailed(String),
}

/// Port of `resumeSession.ts`'s own `resumeSessionCore`'s decision body: the one atomic busy-lock
/// claim, eligibility (status/stop-reason/a FRESH `resolve_termination` -- never a cached, stale
/// `terminatedUnexpectedly`), start, the "did the restart actually come back" check, and send --
/// everything that does NOT need live registry/`build_snapshot` access, which stays in the IPC
/// handler (`sessions_resume`) as the thin, registry-specific glue this trait does not know
/// about. Gate-fix (code review LOW): the lock is claimed BEFORE the eligibility check now (TS
/// checks busy first too), closing the window a check-then-claim order left open. Returns `Ok(())`
/// whether or not the instruction was actually sent (same as the TS `Result<SessionSnapshot>`
/// shape this feeds -- the caller rebuilds the snapshot from the registry either way); tests
/// observe the fake's own `send_called` flag instead of an extra wrapper type here.
pub(crate) async fn resume_session_core<A: ResumableAgent>(
    agent: &A,
    id: &str,
    archived: bool,
) -> Result<(), ResumeCoreError> {
    let Some(_guard) = try_lock_resuming(id) else {
        return Err(ResumeCoreError::Refused("busy"));
    };
    let status = agent.status().await;
    let stop_reason = agent.stop_reason().await;
    let detection = agent.resolve_termination().await;
    if let Some(code) = check_resume_eligible(
        status,
        stop_reason.as_deref(),
        detection.terminated_unexpectedly,
        archived,
    ) {
        return Err(ResumeCoreError::Refused(code));
    }
    let _ = agent.start().await;
    agent.notify_list_changed().await;
    if agent.status().await == SessionStatus::Stopped {
        // The restart itself failed (e.g. start-failed): never send the instruction into a
        // Session that did not actually come back.
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

    async fn start(&self) -> Result<(), AgentError> {
        self.agent.start().await
    }

    async fn notify_list_changed(&self) {
        self.state.session_manager.notify_list_changed();
    }

    async fn send_resume_instruction(&self) -> Result<(), AgentError> {
        // Belt-and-braces re-check right before the one irreversible step: a concurrent
        // archive/delete could have landed during `start()`'s own await. No fallback to an
        // earlier snapshot on a miss -- a deleted Session must never be treated as the stale,
        // non-archived copy.
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

/// `sessions.resume` (issue #509/#786): recover (if needed) then send
/// `DEFAULT_RESUME_INSTRUCTION` as a real turn, atomically and server-side-locked per Session id.
pub fn sessions_resume(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(id) = args.first().and_then(Value::as_str).map(str::to_string) else {
            return Err(invalid_argument("sessions.resume expects a string id"));
        };
        let Some(session) = state.registry.lock().await.get_session(&id).cloned() else {
            return Err(not_found(format!("Session not found: {id}")));
        };
        // An archived Session whose agent crashed this run before being archived keeps
        // `stopReason: 'agent-exited'`, which the eligibility check below would otherwise
        // accept -- refused before the tail read (never worth a 256 KiB read for a Session
        // Resume can never apply to).
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

// -------------------------------------------------------------------------------------------
// Attach/open/recover (`sessions.open`/`.recover`): injectable core
// -------------------------------------------------------------------------------------------

/// Minimal seam `attach_snapshot_decision` needs -- port of `attachSnapshot.ts`'s own
/// `AttachableAgent`.
pub(crate) trait AttachableAgent {
    async fn status(&self) -> SessionStatus;
    async fn stop_reason(&self) -> Option<String>;
    async fn resolve_termination(&self) -> TerminationDetectionResult;
    async fn start(&self) -> Result<(), AgentError>;
    async fn notify_list_changed(&self);
}

/// Port of `ipc/attachSnapshot.ts`'s own `attachSnapshotCore`'s decision body: `force_start`
/// restarts regardless of reason (including `agent-exited`); a passive open only starts when
/// `can_auto_start` says the Session was never wrong to begin with. Returns the FRESH
/// `TerminationDetectionResult` to thread into `build_snapshot` whenever (and only whenever) the
/// Session actually was `Stopped` (`None` otherwise: nothing needed computing, same as the
/// previous shape) -- never `runtime_view()`'s own cached value, which only ever reflects a
/// crash THIS live agent's own `on_exit` actually observed.
pub(crate) async fn attach_snapshot_decision<A: AttachableAgent>(
    agent: &A,
    force_start: bool,
) -> Option<TerminationDetectionResult> {
    if agent.status().await != SessionStatus::Stopped {
        return None;
    }
    // A requested stop is never read from the tail at all (`resolve_termination` honours the
    // in-memory `stoppedOnRequest` flag and the persisted marker alike): FR-038 ("stopAgent
    // reattaches when reopened") needs this, otherwise a tool call still outstanding when a
    // deliberate stop fired looks identical, from the file alone, to a crash.
    let detection = agent.resolve_termination().await;
    let stop_reason = agent.stop_reason().await;
    if force_start || can_auto_start(stop_reason.as_deref(), detection.terminated_unexpectedly) {
        let _ = agent.start().await;
        agent.notify_list_changed().await;
    }
    Some(detection)
}

struct AttachAgentAdapter<'a> {
    state: &'a AppState,
    agent: Arc<SessionAgent>,
}

impl AttachableAgent for AttachAgentAdapter<'_> {
    async fn status(&self) -> SessionStatus {
        self.agent.status().await
    }

    async fn stop_reason(&self) -> Option<String> {
        stop_reason_of(&self.agent.runtime_view().await)
    }

    async fn resolve_termination(&self) -> TerminationDetectionResult {
        self.agent.resolve_termination().await
    }

    async fn start(&self) -> Result<(), AgentError> {
        self.agent.start().await
    }

    async fn notify_list_changed(&self) {
        self.state.session_manager.notify_list_changed();
    }
}

/// Shared by `sessions.open` (`force_start = false`) and `sessions.recover` (`force_start =
/// true`).
async fn attach_snapshot_core(
    state: &AppState,
    id: &str,
    force_start: bool,
) -> Result<Value, super::IpcError> {
    let Some(session) = state.registry.lock().await.get_session(id).cloned() else {
        return Err(not_found(format!("Session not found: {id}")));
    };
    let agent = state.session_manager.get_or_create_agent(id);
    let adapter = AttachAgentAdapter {
        state,
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

/// `sessions.open` (T024): auto-starts a `stopped` Session when nothing is wrong with the agent
/// itself (`can_auto_start`). `userAction` (issue #509 quality-gate fix) bypasses this gate
/// outright -- a user explicitly sending a message to a not-yet-opened pane must still start the
/// agent, same as `force_start` below.
pub fn sessions_open(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(id) = args.first().and_then(Value::as_str).map(str::to_string) else {
            return Err(invalid_argument("sessions.open expects a string id"));
        };
        let user_action = args.get(1).and_then(Value::as_bool).unwrap_or(false);
        attach_snapshot_core(&state, &id, user_action).await
    })
}

/// `sessions.recover` (issue #786): the same reattach path as `sessions.open`, but always
/// restarts regardless of `stopReason` (including `agent-exited`) -- the explicit user action
/// FR-034's crashed/failed-agent gate exists to require before a fresh attempt.
pub fn sessions_recover(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(id) = args.first().and_then(Value::as_str).map(str::to_string) else {
            return Err(invalid_argument("sessions.recover expects a string id"));
        };
        attach_snapshot_core(&state, &id, true).await
    })
}

/// `sessions.keepWaitingForStart` (issue #512's "Keep waiting" button): a no-op (still `ok:
/// true`) if the Session is not currently at the `prompt` stage.
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

/// `sessions.cancelStart` (issue #512's "Cancel" button): a no-op (still `ok: true`) if the
/// Session is not currently starting.
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

/// `sessions.stopAgent` (T040): closes stdin, awaits a graceful exit, then force-kills via the
/// Job Object's owning process tree (`OmpProcess::stop`, FR-004).
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

/// `sessions.setVisible` (T036/T037, spec 005 Decision 2): at most two session ids (a single
/// pane, or a split).
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
