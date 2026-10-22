// Queued role / model / reasoning changes (lane RM, issue #766 part A).
//
// While a Session is working or stopped, `model.setModel`/`cycleModel`/`applyRole`/
// `setThinkingLevel` no longer refuse: they store the choice in the Session's own pending slots
// and return `queued: true`. Nothing is ever sent to OMP mid-turn. The slots are drained at the
// next idle (`session::model::on_frame`'s settle hook, `SessionAgent::send` just before a prompt
// goes out) and right after the agent starts (`launch()`), role/model first, then reasoning.
//
// - One slot for the role/model choice (a role to apply, a concrete model to pin, or a
//   `cycle_model` step) and one for the reasoning level. The last choice wins.
// - Choosing the value that is already applied while not idle clears the slot ("Keep current").
// - Pending state is in memory only: an app restart drops it (same as `State.pinned`'s own
//   non-persisted reads before #741).
// - A drain that fails for any reason other than the Session being busy/not running again drops
//   the value and posts an Error notice in the transcript; a busy/not-running failure keeps it.

use serde_json::{json, Value};

use crate::omp::transcript::NoticeLevel;

use super::agent::{AgentError, SessionAgent, SessionStatus};
use super::model;
use super::model::model_support::post_notice;
use super::thinking_level;

/// Same bound `model_support::is_switch_argument_token` uses for a model/role token.
const MAX_MODEL_FIELD_LEN: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Target {
    Role(String),
    Model {
        provider: String,
        model_id: String,
    },
    /// A queued `cycleModel` step: its resulting model is only known when it is applied.
    Cycle,
}

#[derive(Default)]
pub(super) struct PendingSelection {
    target: Option<Target>,
    thinking: Option<String>,
}

impl PendingSelection {
    fn take(&mut self) -> (Option<Target>, Option<String>) {
        (self.target.take(), self.thinking.take())
    }

    /// Puts drained values back, but only into slots the user has not refilled meanwhile.
    fn restore(&mut self, target: Option<Target>, thinking: Option<String>) {
        if self.target.is_none() {
            self.target = target;
        }
        if self.thinking.is_none() {
            self.thinking = thinking;
        }
    }

    /// `SessionSummary.pendingSelection` (`src/shared/ipc.ts`): `None` when nothing is pending.
    /// Both `role` and `model` are `null` only while a `cycleModel` step is queued.
    fn to_wire(&self) -> Option<Value> {
        if self.target.is_none() && self.thinking.is_none() {
            return None;
        }
        let role = match &self.target {
            Some(Target::Role(role)) => json!(role),
            _ => Value::Null,
        };
        let model = match &self.target {
            Some(Target::Model { provider, model_id }) => {
                json!({ "provider": provider, "modelId": model_id })
            }
            _ => Value::Null,
        };
        Some(json!({ "role": role, "model": model, "thinkingLevel": self.thinking }))
    }
}

/// `SessionSummary.pendingSelection` for `SessionAgent::summary_fields`.
pub(super) async fn wire(agent: &SessionAgent) -> Option<Value> {
    agent.with_model_state(|s| s.pending.to_wire()).await
}

fn changed(agent: &SessionAgent) {
    agent.events().emit_session_list_changed();
}

/// Shared with `model::apply_role`: an unknown role is refused before anything is sent or queued
/// (OMP's own `/switch @<role>` silently no-ops on one it cannot resolve, FINDINGS item 53).
pub(super) fn validate_known_role(role: &str, known_roles: &[String]) -> Result<(), AgentError> {
    if known_roles.iter().any(|r| r == role) {
        return Ok(());
    }
    Err(AgentError::new(
        "invalid-argument",
        format!(
            "Unknown role: {role}. Valid roles: {}",
            known_roles.join(", ")
        ),
    ))
}

fn retryable(err: &AgentError) -> bool {
    err.code == "not-idle" || err.code == "agent-not-running"
}

async fn is_idle(agent: &SessionAgent) -> bool {
    agent.status().await == SessionStatus::Idle
}

async fn current_model(agent: &SessionAgent) -> Option<crate::store::registry::LastModel> {
    agent
        .registry()
        .lock()
        .await
        .get_session(agent.session_id())?
        .last_model
        .clone()
}

fn model_json(model: Option<&crate::store::registry::LastModel>) -> Value {
    match model {
        Some(m) => json!({ "provider": m.provider, "id": m.id, "name": m.name }),
        None => Value::Null,
    }
}

async fn set_target(agent: &SessionAgent, target: Option<Target>) {
    agent.with_model_state(|s| s.pending.target = target).await;
    changed(agent);
}

/// Queue-or-clear for a role/model/cycle choice made while the Session is not idle.
/// `is_current` is true when the choice equals what is applied now (cancels any pending value).
async fn queue_target(
    agent: &SessionAgent,
    target: Target,
    is_current: bool,
    result: Value,
) -> Result<Value, AgentError> {
    if is_current {
        set_target(agent, None).await;
        return Ok(result);
    }
    set_target(agent, Some(target)).await;
    let mut result = result;
    result["queued"] = Value::Bool(true);
    Ok(result)
}

/// `model.setModel`. Idle: applied now (pins the Session). Otherwise queued, or a no-op that
/// clears the slot when this model is already the pinned one. A queued result carries the
/// requested `{provider, id}` as `model`.
pub async fn choose_model(
    agent: &SessionAgent,
    provider: &str,
    model_id: &str,
) -> Result<Value, AgentError> {
    if provider.is_empty()
        || model_id.is_empty()
        || provider.len() > MAX_MODEL_FIELD_LEN
        || model_id.len() > MAX_MODEL_FIELD_LEN
    {
        return Err(AgentError::new(
            "invalid-argument",
            "A model needs a provider and a model id.",
        ));
    }
    if is_idle(agent).await {
        match model::set_model(agent, provider, model_id).await {
            Ok(value) => {
                set_target(agent, None).await;
                return Ok(value);
            }
            Err(err) if !retryable(&err) => return Err(err),
            Err(_) => {}
        }
    }
    let (pinned, _) = model::current_selection(agent).await;
    let current = current_model(agent).await;
    let is_current = pinned
        && current
            .as_ref()
            .is_some_and(|m| m.provider == provider && m.id == model_id);
    let result = if is_current {
        json!({ "model": model_json(current.as_ref()) })
    } else {
        json!({ "model": { "provider": provider, "id": model_id } })
    };
    let target = Target::Model {
        provider: provider.to_string(),
        model_id: model_id.to_string(),
    };
    queue_target(agent, target, is_current, result).await
}

/// `model.cycleModel`. Idle: applied now. Otherwise one `cycle_model` step is queued; `model`
/// is the model known to be applied now (`null` if never read), since the target is not known.
pub async fn choose_cycle(agent: &SessionAgent) -> Result<Value, AgentError> {
    if is_idle(agent).await {
        match model::cycle_model(agent).await {
            Ok(value) => {
                set_target(agent, None).await;
                return Ok(value);
            }
            Err(err) if !retryable(&err) => return Err(err),
            Err(_) => {}
        }
    }
    let result = json!({ "model": model_json(current_model(agent).await.as_ref()) });
    queue_target(agent, Target::Cycle, false, result).await
}

/// `model.applyRole`. Idle: applied now (un-pins). Otherwise queued, or a no-op that clears the
/// slot when this role is already the applied one. `model` is the model known to be applied now
/// (`null` if never read); `role` is the requested role.
pub async fn choose_role(
    agent: &SessionAgent,
    role: &str,
    known_roles: &[String],
) -> Result<Value, AgentError> {
    validate_known_role(role, known_roles)?;
    if is_idle(agent).await {
        match model::apply_role(agent, role, known_roles).await {
            Ok(value) => {
                set_target(agent, None).await;
                return Ok(value);
            }
            Err(err) if !retryable(&err) => return Err(err),
            Err(_) => {}
        }
    }
    let (pinned, current_role) = model::current_selection(agent).await;
    let is_current = !pinned && current_role.as_deref() == Some(role);
    let result = json!({
        "model": model_json(current_model(agent).await.as_ref()),
        "role": role,
    });
    queue_target(agent, Target::Role(role.to_string()), is_current, result).await
}

/// `model.setThinkingLevel`. Idle: applied now. Otherwise queued (`thinkingLevel` is the
/// requested level), or a no-op that clears the slot when it is already the stored level.
pub async fn choose_thinking_level(agent: &SessionAgent, level: &str) -> Result<Value, AgentError> {
    thinking_level::validate_level(level)?;
    if is_idle(agent).await {
        match thinking_level::set_thinking_level(agent, level).await {
            Ok(value) => {
                set_thinking(agent, None).await;
                return Ok(value);
            }
            Err(err) if !retryable(&err) => return Err(err),
            Err(_) => {}
        }
    }
    let stored = agent
        .registry()
        .lock()
        .await
        .get_session(agent.session_id())
        .and_then(|s| s.last_thinking_level.clone());
    if stored.as_deref() == Some(level) {
        set_thinking(agent, None).await;
        return Ok(json!({ "thinkingLevel": level }));
    }
    set_thinking(agent, Some(level.to_string())).await;
    Ok(json!({ "thinkingLevel": level, "queued": true }))
}

async fn set_thinking(agent: &SessionAgent, level: Option<String>) {
    agent.with_model_state(|s| s.pending.thinking = level).await;
    changed(agent);
}

/// Applies the pending role/model, then the pending reasoning level, if the Session is idle.
/// Never sends anything while it is not. Run at settle, after agent start, and before a prompt.
pub(super) async fn drain(agent: &SessionAgent) {
    if !is_idle(agent).await {
        return;
    }
    let (target, thinking) = agent.with_model_state(|s| s.pending.take()).await;
    if target.is_none() && thinking.is_none() {
        return;
    }
    changed(agent);
    if let Some(chosen) = &target {
        let (label, outcome) = match chosen {
            Target::Role(role) => (
                format!("role change to \"{role}\""),
                model::apply_role_now(agent, role, false, None, None).await,
            ),
            Target::Model { provider, model_id } => (
                format!("model change to {provider}/{model_id}"),
                model::set_model(agent, provider, model_id).await,
            ),
            Target::Cycle => ("model change".to_string(), model::cycle_model(agent).await),
        };
        if let Err(err) = outcome {
            if retryable(&err) {
                restore(agent, target, thinking).await;
                return;
            }
            post_notice(
                agent,
                NoticeLevel::Error,
                format!("The queued {label} could not be applied: {}", err.message),
            )
            .await;
        }
    }
    if let Some(level) = thinking {
        if let Err(err) = thinking_level::set_thinking_level(agent, &level).await {
            if retryable(&err) {
                restore(agent, None, Some(level)).await;
                return;
            }
            post_notice(
                agent,
                NoticeLevel::Error,
                format!(
                    "The queued reasoning change could not be applied: {}",
                    err.message
                ),
            )
            .await;
        }
    }
}

async fn restore(agent: &SessionAgent, target: Option<Target>, thinking: Option<String>) {
    agent
        .with_model_state(|s| s.pending.restore(target, thinking))
        .await;
    changed(agent);
}

#[cfg(test)]
#[path = "pending_selection.test.rs"]
mod tests;
