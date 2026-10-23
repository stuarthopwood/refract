// Queued role / model / reasoning changes (lane RM, issue #766 part A).
//
// While a Session is working or stopped, `model.setModel`/`cycleModel`/`applyRole`/
// `setThinkingLevel` no longer refuse: they store the choice in the Session's own pending slots
// and return `queued: true`. Nothing is ever sent to OMP mid-turn. The slots are drained at the
// next idle (`session::model::on_frame`'s settle hook, `SessionAgent::send` just before a prompt
// goes out) and right after the agent starts (`launch()`), role/model first, then reasoning.
//
// - One slot for the role/model choice (a role to apply or a concrete model to pin) and one for
//   the reasoning level. The last choice wins. `cycleModel` is never queued (it refuses
//   `not-idle` while not idle).
// - A per-Session async drain guard (`State.drain_guard`) is held across take()+RPC by every drain
//   and every idle-path apply, and `SessionAgent::send` drains (so awaits it) before a prompt,
//   so a prompt never overtakes an in-flight apply. The idle-vs-queue decision and the store
//   happen under one `state` lock (`store_pending_unless_idle`).
// - Choosing the value that is already applied while not idle clears the slot ("Keep current").
// - Pending state is in memory only: an app restart drops it (same as `State.pinned`'s own
//   non-persisted reads before #741).
// - A drain that fails for any reason other than the Session being busy/not running again drops
//   the value and posts an Error notice in the transcript; a busy/not-running failure keeps it.

use serde_json::{json, Value};
use tokio::sync::OwnedMutexGuard;

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
    Model { provider: String, model_id: String },
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
    /// A pending role/model choice has exactly one of `role`/`model` non-null.
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

async fn set_thinking(agent: &SessionAgent, level: Option<String>) {
    agent.with_model_state(|s| s.pending.thinking = level).await;
    changed(agent);
}

async fn lock_drain(agent: &SessionAgent) -> OwnedMutexGuard<()> {
    let guard = agent.with_model_state(|s| s.drain_guard.clone()).await;
    guard.lock_owned().await
}

/// One slot's new value, applied atomically with the not-idle check.
#[derive(Clone)]
enum Slot {
    Target(Option<Target>),
    Thinking(Option<String>),
}

/// Stores `slot` only while the Session is not idle (one `state` lock, no gap a settle could land
/// in). `false`: idle, the caller applies the choice now.
async fn store_unless_idle(agent: &SessionAgent, slot: Slot) -> bool {
    let stored = agent
        .store_pending_unless_idle(|s| match slot {
            Slot::Target(target) => s.pending.target = target,
            Slot::Thinking(level) => s.pending.thinking = level,
        })
        .await;
    if stored {
        changed(agent);
    }
    stored
}

/// The Session turned non-idle between the idle check and the apply (retryable failure): store
/// the choice and drain, so it never sits pending on a Session that is actually idle.
async fn store_and_drain(agent: &SessionAgent, slot: Slot, guard: OwnedMutexGuard<()>) {
    match slot {
        Slot::Target(target) => set_target(agent, target).await,
        Slot::Thinking(level) => set_thinking(agent, level).await,
    }
    drop(guard);
    drain(agent).await;
}

fn queued(mut result: Value, is_current: bool) -> Value {
    if !is_current {
        result["queued"] = Value::Bool(true);
    }
    result
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
    let guard = lock_drain(agent).await;
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
    let slot = Slot::Target(if is_current {
        None
    } else {
        Some(Target::Model {
            provider: provider.to_string(),
            model_id: model_id.to_string(),
        })
    });
    if store_unless_idle(agent, slot.clone()).await {
        return Ok(queued(result, is_current));
    }
    match model::set_model(agent, provider, model_id).await {
        Ok(value) => {
            set_target(agent, None).await;
            Ok(value)
        }
        Err(err) if !retryable(&err) => Err(err),
        Err(_) => {
            store_and_drain(agent, slot, guard).await;
            Ok(queued(result, is_current))
        }
    }
}

/// `model.cycleModel`. Never queued (its target is only known once applied): applied now when
/// idle, otherwise refuses `not-idle`. Takes the drain guard so it cannot interleave with a drain.
pub async fn choose_cycle(agent: &SessionAgent) -> Result<Value, AgentError> {
    let _guard = lock_drain(agent).await;
    model::cycle_model(agent).await
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
    let guard = lock_drain(agent).await;
    let (pinned, current_role) = model::current_selection(agent).await;
    let is_current = !pinned && current_role.as_deref() == Some(role);
    let result = json!({
        "model": model_json(current_model(agent).await.as_ref()),
        "role": role,
    });
    let slot = Slot::Target(if is_current {
        None
    } else {
        Some(Target::Role(role.to_string()))
    });
    if store_unless_idle(agent, slot.clone()).await {
        return Ok(queued(result, is_current));
    }
    match model::apply_role(agent, role, known_roles).await {
        Ok(value) => {
            set_target(agent, None).await;
            Ok(value)
        }
        Err(err) if !retryable(&err) => Err(err),
        Err(_) => {
            store_and_drain(agent, slot, guard).await;
            Ok(queued(result, is_current))
        }
    }
}

/// `model.setThinkingLevel`. Idle: applied now. Otherwise queued (`thinkingLevel` is the
/// requested level), or a no-op that clears the slot when it is already the stored level.
pub async fn choose_thinking_level(agent: &SessionAgent, level: &str) -> Result<Value, AgentError> {
    thinking_level::validate_level(level)?;
    let guard = lock_drain(agent).await;
    let stored = agent
        .registry()
        .lock()
        .await
        .get_session(agent.session_id())
        .and_then(|s| s.last_thinking_level.clone());
    let is_current = stored.as_deref() == Some(level);
    let slot = Slot::Thinking(if is_current {
        None
    } else {
        Some(level.to_string())
    });
    let result = json!({ "thinkingLevel": level });
    if store_unless_idle(agent, slot.clone()).await {
        return Ok(queued(result, is_current));
    }
    match thinking_level::set_thinking_level(agent, level).await {
        Ok(value) => {
            set_thinking(agent, None).await;
            Ok(value)
        }
        Err(err) if !retryable(&err) => Err(err),
        Err(_) => {
            store_and_drain(agent, slot, guard).await;
            Ok(queued(result, is_current))
        }
    }
}

/// Applies the pending role/model, then the pending reasoning level, if the Session is idle.
/// Never sends anything while it is not. Run at settle, after agent start, and before a prompt.
pub(super) async fn drain(agent: &SessionAgent) {
    let _guard = lock_drain(agent).await;
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
