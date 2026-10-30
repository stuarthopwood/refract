// Thin argument-parsing wrappers over `session::model`; this file validates positional args and maps `AgentError` to `IpcError`.

use std::sync::Arc;

use serde_json::Value;

use crate::session::model;
use crate::session::pending_selection;
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

/// Sets the composer's model picker selection.
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
        let result = pending_selection::choose_model(&agent, provider, model_id)
            .await
            .map_err(map_model_error)?;
        Ok(result)
    })
}

/// Steps through catalog models, never `cycleOrder`'s roles.
pub fn model_cycle_model(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(session_id) = args.first().and_then(Value::as_str) else {
            return Err(invalid_argument("model.cycleModel expects a sessionId"));
        };
        require_session(&state, session_id).await?;
        let agent = manager(&state).get_or_create_agent(session_id);
        let result = pending_selection::choose_cycle(&agent)
            .await
            .map_err(map_model_error)?;
        Ok(result)
    })
}

/// Sets the Reasoning picker level.
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
        let result = pending_selection::choose_thinking_level(&agent, level)
            .await
            .map_err(map_model_error)?;
        Ok(result)
    })
}

/// Validates `role` against `known_role_list()` first: OMP's `/switch @<role>` silently no-ops on an unknown role.
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
        let result = pending_selection::choose_role(&agent, role, &known_roles)
            .await
            .map_err(map_model_error)?;
        Ok(result)
    })
}

/// Lists `cycleOrder` plus `"plan"` with their configured `modelRoles` selectors.
pub fn model_list_roles(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(session_id) = args.first().and_then(Value::as_str) else {
            return Err(invalid_argument("model.listRoles expects a sessionId"));
        };
        require_session(&state, session_id).await?;
        let agent = manager(&state).get_or_create_agent(session_id);
        // Sequential by design: `OMP_INVOCATION_LOCK` already serialises `omp config` calls.
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
