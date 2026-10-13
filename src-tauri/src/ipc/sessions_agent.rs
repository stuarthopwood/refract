// IPC handlers for the agent-backed `sessions.*` subset (contracts/ipc.md "Sessions", tasks.md
// T024/T036/T037/T040): `.open`/`.stopAgent`/`.setVisible` (Phase 3) dispatch into the live
// `session::SessionManager` `AppState::session_manager` carries.
//
// Split from the former `ipc/sessions.rs` (issue #784, "Pre-declare per-lane Rust files") so
// lane R3 (#786, agent start/recovery/resume as a typed state machine) is the only lane that
// ever edits this file; the registry-only `.list`/`.create`/`.rename` arms live in the sibling
// `ipc/sessions_lifecycle.rs` instead (lane R2, #785).

use serde_json::Value;

use super::{invalid_argument, not_found, AppState, Dispatcher, HandlerFuture};

pub fn register(d: &mut Dispatcher) {
    d.register("sessions.open", sessions_open);
    d.register("sessions.stopAgent", sessions_stop_agent);
    d.register("sessions.setVisible", sessions_set_visible);
}

/// `sessions.open` (T024): auto-starts a `stopped` Session when nothing is wrong with the agent
/// itself (port of `ipc/canAutoStart.ts`'s own `canAutoStart`, simplified: `terminatedUnexpectedly`
/// is always `false` in this build, see `session::agent`'s own header, so this reduces to
/// "`stopReason` is absent, `not-started`, or `worktree-missing`"). `userAction` (issue #509
/// quality-gate fix) bypasses this gate outright -- a user explicitly sending a message to a
/// not-yet-opened pane must still start the agent.
pub fn sessions_open(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(id) = args.first().and_then(Value::as_str).map(str::to_string) else {
            return Err(invalid_argument("sessions.open expects a string id"));
        };
        let user_action = args.get(1).and_then(Value::as_bool).unwrap_or(false);
        if state.registry.lock().await.get_session(&id).is_none() {
            return Err(not_found(format!("Session not found: {id}")));
        }
        let agent = state.session_manager.get_or_create_agent(&id);
        if agent.status().await == crate::session::SessionStatus::Stopped {
            let runtime = agent.runtime_view().await;
            let stop_reason = runtime
                .get("stopReason")
                .and_then(Value::as_str)
                .map(str::to_string);
            let can_auto_start = user_action
                || matches!(
                    stop_reason.as_deref(),
                    None | Some("not-started") | Some("worktree-missing")
                );
            if can_auto_start {
                let _ = agent.start().await;
                state.session_manager.notify_list_changed();
            }
        }
        let session = state
            .registry
            .lock()
            .await
            .get_session(&id)
            .cloned()
            .ok_or_else(|| not_found(format!("Session not found: {id}")))?;
        Ok(super::conversations::build_snapshot(&session, &agent).await)
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
