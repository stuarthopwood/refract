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

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex as StdMutex};

use serde_json::Value;

use crate::session::{SessionAgent, SessionStatus};
use crate::store::registry::Session;

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

/// Port of `resumeEligibility.ts`'s own `checkResumeEligible`: the gating half of
/// `sessions.resume`, re-checked server-side rather than trusted from the renderer's own
/// (possibly stale) state.
fn check_resume_eligible(
    resuming_ids: &HashSet<String>,
    id: &str,
    status: SessionStatus,
    stop_reason: Option<&str>,
    terminated_unexpectedly: bool,
    archived: bool,
) -> Option<&'static str> {
    if resuming_ids.contains(id) {
        return Some("busy");
    }
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
/// concurrent IPC calls, not just one function's own stack frame.
static RESUMING_IDS: LazyLock<StdMutex<HashSet<String>>> =
    LazyLock::new(|| StdMutex::new(HashSet::new()));

fn stop_reason_of(runtime: &Value) -> Option<String> {
    runtime
        .get("stopReason")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Shared by `sessions.open` (`force_start = false`) and `sessions.recover` (`force_start =
/// true`): port of `ipc/attachSnapshot.ts`'s own `attachSnapshotCore`. `force_start` restarts
/// regardless of reason (including `agent-exited`); a passive open only starts when
/// `can_auto_start` says the Session was never wrong to begin with.
async fn attach_snapshot_core(
    state: &AppState,
    id: &str,
    force_start: bool,
) -> Result<Value, super::IpcError> {
    let Some(session) = state.registry.lock().await.get_session(id).cloned() else {
        return Err(not_found(format!("Session not found: {id}")));
    };
    let agent = state.session_manager.get_or_create_agent(id);
    if agent.status().await == SessionStatus::Stopped {
        // A requested stop is never read from the tail at all (`SessionAgent::resolve_termination`
        // honours the in-memory `stoppedOnRequest` flag and the persisted marker alike): FR-038
        // ("stopAgent reattaches when reopened") needs this, otherwise a tool call still
        // outstanding when a deliberate stop fired looks identical, from the file alone, to a
        // crash.
        let detection = agent.resolve_termination().await;
        let stop_reason = agent
            .runtime_view()
            .await
            .get("stopReason")
            .and_then(Value::as_str)
            .map(str::to_string);
        if force_start || can_auto_start(stop_reason.as_deref(), detection.terminated_unexpectedly)
        {
            let _ = agent.start().await;
            state.session_manager.notify_list_changed();
        }
    }
    let refreshed = state
        .registry
        .lock()
        .await
        .get_session(id)
        .cloned()
        .unwrap_or(session);
    Ok(super::conversations::build_snapshot(&refreshed, &agent).await)
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

/// `sessions.resume` (issue #509/#786): recover (if needed) then send
/// `DEFAULT_RESUME_INSTRUCTION` as a real turn, atomically and server-side-locked per Session id
/// -- port of `resumeSession.ts`'s own `resumeSessionCore`.
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
        let detection = agent.resolve_termination().await;
        // Re-read fresh: `session` above was read before the `resolve_termination` await, during
        // which a concurrent `sessions.archive`/`.delete` could have landed.
        let Some(fresh) = state.registry.lock().await.get_session(&id).cloned() else {
            return Err(invalid_argument(resume_refusal_message("not-eligible")));
        };
        if fresh.archived_at.is_some() {
            return Err(invalid_argument(resume_refusal_message("not-eligible")));
        }
        let runtime = agent.runtime_view().await;
        let status = agent.status().await;
        let refusal = {
            let resuming = RESUMING_IDS.lock().expect("resuming_ids mutex poisoned");
            check_resume_eligible(
                &resuming,
                &id,
                status,
                stop_reason_of(&runtime).as_deref(),
                detection.terminated_unexpectedly,
                fresh.archived_at.is_some(),
            )
        };
        if let Some(code) = refusal {
            return Err(invalid_argument(resume_refusal_message(code)));
        }
        RESUMING_IDS
            .lock()
            .expect("resuming_ids mutex poisoned")
            .insert(id.clone());
        let result = resume_locked(&state, &id, &agent, fresh).await;
        RESUMING_IDS
            .lock()
            .expect("resuming_ids mutex poisoned")
            .remove(&id);
        result
    })
}

/// The locked body of `sessions.resume`, run while `id` is held in `RESUMING_IDS` (released by
/// the caller's own unconditional removal above on every return path, matching the TS port's own
/// `finally { resumingIds.delete(id) }`).
async fn resume_locked(
    state: &AppState,
    id: &str,
    agent: &std::sync::Arc<SessionAgent>,
    fresh: Session,
) -> Result<Value, super::IpcError> {
    let _ = agent.start().await;
    state.session_manager.notify_list_changed();
    let refreshed = state
        .registry
        .lock()
        .await
        .get_session(id)
        .cloned()
        .unwrap_or(fresh);
    let snapshot = super::conversations::build_snapshot(&refreshed, agent).await;
    if snapshot
        .get("runtime")
        .and_then(|r| r.get("status"))
        .and_then(Value::as_str)
        == Some("stopped")
    {
        // The restart itself failed (e.g. start-failed): never send the instruction into a
        // Session that did not actually come back.
        return Ok(snapshot);
    }
    // Belt-and-braces re-check right before the one irreversible step: a concurrent archive/
    // delete could have landed during `build_snapshot`'s own await. No fallback to `refreshed`
    // on a miss -- a deleted Session must never be treated as the stale, non-archived copy.
    let before_send = state.registry.lock().await.get_session(id).cloned();
    match before_send {
        Some(session) if session.archived_at.is_none() => {}
        _ => {
            agent.shutdown().await;
            return Err(invalid_argument(resume_refusal_message("not-eligible")));
        }
    }
    if let Err(err) = agent
        .send(DEFAULT_RESUME_INSTRUCTION.to_string(), None)
        .await
    {
        return Err(super::IpcError::new("prompt-failed", err.message));
    }
    let post_send = state.registry.lock().await.get_session(id).cloned();
    match post_send {
        Some(session) => Ok(super::conversations::build_snapshot(&session, agent).await),
        None => Ok(snapshot),
    }
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
