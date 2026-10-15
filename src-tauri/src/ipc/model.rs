// IPC handlers for `model.*` (lane RM, issues #454, #740, #741, #762, #766, #760, #564): the
// composer's model picker (`setModel`, `cycleModel`), the Reasoning picker (`setThinkingLevel`),
// and the role selector (`/role`, Ctrl+R: `applyRole`, `listRoles`). Thin argument-parsing
// wrappers over `session::model`'s own business logic (mid-turn refusal, pin/role bookkeeping,
// notices, resolution) -- this file owns only positional-argument validation and the
// `AgentError` -> `IpcError` mapping, the same direct passthrough `ipc::chat`'s own
// `map_chat_error` already uses for this exact error shape (not `map_agent_error`, whose
// whitelist is tuned for session-lifecycle codes this lane never returns: `not-idle`,
// `prompt-failed`, `invalid-argument`, `omp-probe-failed`, `agent-not-running`).

use std::sync::Arc;

use serde_json::Value;

use crate::session::model;
use crate::session::SessionManager;

use super::{invalid_argument, not_found, AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("model.setModel", model_set_model);
    d.register("model.cycleModel", model_cycle_model);
    d.register("model.applyRole", model_apply_role);
    d.register("model.listRoles", model_list_roles);
    d.register("model.setThinkingLevel", model_set_thinking_level);
}

fn manager(state: &AppState) -> &Arc<SessionManager> {
    &state.session_manager
}

fn map_model_error(err: crate::session::AgentError) -> IpcError {
    IpcError::new(err.code, err.message)
}

async fn require_session(state: &AppState, session_id: &str) -> Result<(), IpcError> {
    if state
        .registry
        .lock()
        .await
        .get_session(session_id)
        .is_none()
    {
        return Err(not_found(format!("Session not found: {session_id}")));
    }
    Ok(())
}

/// #454: the composer's model picker, `(sessionId, provider, modelId)`.
pub fn model_set_model(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let (Some(session_id), Some(provider), Some(model_id)) = (
            args.first().and_then(Value::as_str),
            args.get(1).and_then(Value::as_str),
            args.get(2).and_then(Value::as_str),
        ) else {
            return Err(invalid_argument(
                "model.setModel expects (sessionId, provider, modelId) strings",
            ));
        };
        require_session(&state, session_id).await?;
        let agent = manager(&state).get_or_create_agent(session_id);
        let result = model::set_model(&agent, provider, model_id)
            .await
            .map_err(map_model_error)?;
        Ok(result)
    })
}

/// #454: the composer's keyboard/toolbar cycle, `(sessionId)`. FINDINGS item 54: steps through
/// catalog models, never `cycleOrder`'s roles.
pub fn model_cycle_model(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(session_id) = args.first().and_then(Value::as_str) else {
            return Err(invalid_argument("model.cycleModel expects a sessionId"));
        };
        require_session(&state, session_id).await?;
        let agent = manager(&state).get_or_create_agent(session_id);
        let result = model::cycle_model(&agent).await.map_err(map_model_error)?;
        Ok(result)
    })
}

/// #564: the composer's Reasoning picker, `(sessionId, level)`.
pub fn model_set_thinking_level(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let (Some(session_id), Some(level)) = (
            args.first().and_then(Value::as_str),
            args.get(1).and_then(Value::as_str),
        ) else {
            return Err(invalid_argument(
                "model.setThinkingLevel expects (sessionId, level) strings",
            ));
        };
        require_session(&state, session_id).await?;
        let agent = manager(&state).get_or_create_agent(session_id);
        let result = model::set_thinking_level(&agent, level)
            .await
            .map_err(map_model_error)?;
        Ok(result)
    })
}

/// #766: the Ctrl+R selector and a role chip click, `(sessionId, role)`. `role` is validated
/// against `known_role_list()` before anything is sent (FINDINGS item 53's documented gap: OMP's
/// own `/switch @<role>` silently no-ops on an unresolvable argument rather than erroring).
pub fn model_apply_role(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let (Some(session_id), Some(role)) = (
            args.first().and_then(Value::as_str),
            args.get(1).and_then(Value::as_str),
        ) else {
            return Err(invalid_argument(
                "model.applyRole expects (sessionId, role) strings",
            ));
        };
        require_session(&state, session_id).await?;
        let known_roles = model::known_role_list().await.map_err(map_model_error)?;
        let agent = manager(&state).get_or_create_agent(session_id);
        let result = model::apply_role(&agent, role, &known_roles)
            .await
            .map_err(map_model_error)?;
        Ok(result)
    })
}

/// #766: the Ctrl+R selector's own listing, `(sessionId)` -- `cycleOrder` plus `"plan"`, each
/// resolved to its configured `modelRoles` selector (raw string; the renderer's own catalog
/// lookup turns it into a friendly, provider-free name, #741), with this Session's own
/// current/pinned state so the UI can mark "current".
pub fn model_list_roles(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(session_id) = args.first().and_then(Value::as_str) else {
            return Err(invalid_argument("model.listRoles expects a sessionId"));
        };
        require_session(&state, session_id).await?;
        let agent = manager(&state).get_or_create_agent(session_id);
        // These two `omp` CLI reads run sequentially (not concurrently): every real `omp
        // config get/set` invocation is already serialised process-wide by `OMP_INVOCATION_LOCK`
        // (`omp/config.rs`), so this ordering is incidental, not the safety mechanism.
        let known_roles = model::known_role_list().await.map_err(map_model_error)?;
        let model_roles = crate::ipc::model_roles::get_model_roles()
            .await
            .map_err(|err| IpcError::new("omp-probe-failed", err.to_string()))?;
        let (pinned, current_role) = model::current_selection(&agent).await;
        let roles: Vec<Value> = known_roles
            .iter()
            .map(|role| {
                serde_json::json!({
                    "role": role,
                    "model": model_roles.get(role),
                    "current": !pinned && current_role.as_deref() == Some(role.as_str()),
                })
            })
            .collect();
        Ok(serde_json::json!({
            "roles": roles,
            "currentRole": if pinned { None } else { current_role },
            "pinned": pinned,
        }))
    })
}
