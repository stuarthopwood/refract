// Model roles and commands. Changes queue until idle: mid-turn switches are unsafe on OMP 18.10.1.
// `/plan` has no RPC route in OMP, so it stays refused.

use serde::Serialize;
use serde_json::{json, Value};

use crate::omp::process::ReadyWaitStage;
use crate::omp::transcript::NoticeLevel;

use super::agent::{AgentError, SessionAgent};

pub(in crate::session) mod model_support;

use model_support::{
    friendly_model_text, is_switch_argument_token, model_value, post_notice, selector_matches_model,
};

/// Matches `agent::mod`'s `DEFAULT_REQUEST_TIMEOUT_MS`. `pub(super)` so `thinking_level.rs` shares it.
pub(super) const REQUEST_TIMEOUT_MS: u64 = 60_000;

/// Lane RM's per-Session state, held inside `AgentState`.
#[derive(Default)]
pub(super) struct State {
    /// True once the model was chosen directly; a Settings role change then skips this Session.
    pub(super) pinned: bool,
    /// The role this Session is on; `None` until lazily read from its Conversation file, never guessed.
    pub(super) current_role: Option<String>,
    /// Set when a role change lands mid-turn; `on_frame` applies it at the next settle.
    pub(super) pending_role_reapply: Option<String>,
    /// Pending role/model and reasoning choices made while not idle.
    pub(super) pending: super::pending_selection::PendingSelection,
    /// Held across take() and RPC by every drain and idle-path apply.
    pub(super) drain_guard: std::sync::Arc<tokio::sync::Mutex<()>>,
    /// Conversation path probed with no `model_change` entry; skips re-reading it on every poll.
    pub(super) role_probed_path: Option<String>,
    pub(super) pinned_seeded: bool, // #741 decision 1: guards `model_support::ensure_pin_seeded`
    /// Forces one re-read while pinned, so a fallback outranks the pin.
    pub(super) role_needs_reprobe: bool,
    /// Bumped on each invalidation; a read only writes back if the generation is unchanged.
    pub(super) role_generation: u64,
    /// Monotonic id source for this lane's transcript notices.
    notice_seq: u64,
}

/// Outcome of the #740 sweep over live Sessions after a role's config value changes.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleChangeSummary {
    pub moved: Vec<String>,
    pub queued: Vec<String>,
    pub skipped_pinned: Vec<String>,
    /// Stopped Sessions resume their saved model on next start.
    pub skipped_stopped: Vec<String>,
    pub failed: Vec<String>,
}

pub(super) async fn on_frame(agent: &SessionAgent, frame_type: &str, frame: &Value) {
    // #741 decision 2: a model-change/fallback frame invalidates the cached role (`model_support.rs`).
    model_support::maybe_invalidate_role_cache(agent, frame_type).await;
    // Matches `agent::frame`'s settle detection; `handle_turn_settled` runs first, so the reapply sees Idle.
    let settled = frame_type == "session_settled"
        || (frame_type == "prompt_result"
            && frame.get("sessionSettled").and_then(Value::as_bool) == Some(true));
    if !settled {
        return;
    }
    let pending = agent
        .with_model_state(|s| s.pending_role_reapply.take())
        .await;
    // Runs on a cloned `Arc` so the frame listener never waits on these RPCs.
    let agent = agent.arc();
    tokio::spawn(async move {
        if let Some(role) = pending {
            // Re-queue only on `not-idle`; other errors already posted a notice, so they are final.
            if let Err(err) = apply_role_now(&agent, &role, true, None, None).await {
                if err.code == "not-idle" {
                    agent
                        .with_model_state(|s| {
                            if s.pending_role_reapply.is_none() {
                                s.pending_role_reapply = Some(role);
                            }
                        })
                        .await;
                }
            }
        }
        // Order is deliberate: Settings reapply first, then the user's queued choice (last wins).
        super::pending_selection::drain(&agent).await;
    });
}

pub(super) async fn on_exit(_agent: &SessionAgent, _code: Option<i32>, _requested: bool) {
    // No-op: a pin or role choice belongs to the Session, not to one process lifetime.
}

pub(super) async fn on_start_progress(
    _agent: &SessionAgent,
    _stage: ReadyWaitStage,
    _elapsed_ms: u64,
) {
    // No-op: this lane has no start-progress banner content.
}

// Role lookup.

/// Read access to this lane's per-Session state; the resolve logic lives in `model_support`.
pub async fn current_selection(agent: &SessionAgent) -> (bool, Option<String>) {
    model_support::ensure_pin_seeded(agent).await; // #741 decision 1
    model_support::resolve_current_selection(agent).await
}

/// Runs once the process has launched and `get_state` is applied: seeds the role (#1878).
pub(super) async fn on_launch(agent: &SessionAgent) {
    model_support::seed_role_at_launch(agent).await;
}

/// `cycleOrder` (read fresh each call) plus `"plan"` (#766): the Ctrl+R selector's listing and
/// cycling order. Narrower than `known_chat_role_list` on purpose.
pub async fn known_role_list() -> Result<Vec<String>, AgentError> {
    let response = crate::omp::config::get_config("cycleOrder", &[])
        .await
        .map_err(|err| AgentError::new("omp-probe-failed", err.to_string()))?;
    let cycle_order = model_support::parse_cycle_order_response(&response)
        .map_err(|msg| AgentError::new("omp-probe-failed", msg))?;
    Ok(model_support::build_role_list(&cycle_order))
}

/// The one validation set for `/role <role>` and `/switch @<role>`. Ctrl+R stays narrower.
/// Reads run sequentially under `OMP_INVOCATION_LOCK`; `try_join!` dropped roles intermittently.
pub async fn known_chat_role_list() -> Result<Vec<String>, AgentError> {
    let roles = known_role_list().await?;
    let model_roles = crate::ipc::model_roles::get_model_roles_reliable()
        .await
        .map_err(|err| AgentError::new("omp-probe-failed", err.to_string()))?;
    let merged = model_support::merge_chat_roles(roles, &model_roles);
    log::debug!(
        "known_chat_role_list: model_roles_keys={} merged={merged:?}",
        model_roles.len()
    );
    Ok(merged)
}

// User-initiated actions (composer picker, `/switch`, `/role`, Ctrl+R).

/// Shared RPC path for `set_model` and `cycle_model`. Both pick a concrete model and pin it.
async fn pick_model_via_rpc(
    agent: &SessionAgent,
    cmd: Value,
    not_found_message: &str,
) -> Result<Value, AgentError> {
    let res = agent
        .request_rpc_if_idle(cmd, REQUEST_TIMEOUT_MS, "Switch the model")
        .await?;
    if res.get("success").and_then(Value::as_bool) != Some(true) {
        let message = res
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or(not_found_message)
            .to_string();
        return Err(AgentError::new("prompt-failed", message));
    }
    let data = agent.refresh_from_state().await.map_err(|err| {
        AgentError::new(
            "prompt-failed",
            format!(
                "Model switched, but the new state could not be confirmed: {}",
                err.message
            ),
        )
    })?;
    let model = model_value(&data).ok_or_else(|| {
        AgentError::new(
            "prompt-failed",
            "Model switched, but the new model could not be read.",
        )
    })?;
    agent
        .with_model_state(|s| {
            s.pinned = true;
            s.pinned_seeded = true; // gate round 1 fix (LOW #9): this writer's own pin IS the seed
            s.current_role = None;
            s.pending_role_reapply = None;
        })
        .await;
    model_support::persist_pinned(agent).await;
    post_notice(
        agent,
        NoticeLevel::Info,
        format!("Model switched to {}.", friendly_model_text(&data)),
    )
    .await;
    Ok(json!({ "model": model }))
}

/// The composer's model picker. Session-scoped only; pins the Session and clears its role.
pub async fn set_model(
    agent: &SessionAgent,
    provider: &str,
    model_id: &str,
) -> Result<Value, AgentError> {
    pick_model_via_rpc(
        agent,
        json!({ "type": "set_model", "provider": provider, "modelId": model_id }),
        "Model not found.",
    )
    .await
}

/// Steps through OMP's `cycle_model` RPC. Not a role cycle, so it pins like `set_model`.
pub async fn cycle_model(agent: &SessionAgent) -> Result<Value, AgentError> {
    pick_model_via_rpc(
        agent,
        json!({ "type": "cycle_model" }),
        "Could not switch models.",
    )
    .await
}

/// Pre-switch guard: refuses if `get_state` fails or OMP reports `isStreaming`. Refract's own
/// idle check lags the `agent_start` frame, so OMP's flag is the only reliable signal.
async fn refresh_state_or_refuse(agent: &SessionAgent) -> Result<Value, AgentError> {
    let state = agent.refresh_from_state().await.map_err(|err| {
        AgentError::new(
            "prompt-failed",
            format!(
                "Could not confirm the Session's current model: {}",
                err.message
            ),
        )
    })?;
    if state.get("isStreaming").and_then(Value::as_bool) == Some(true) {
        return Err(AgentError::new(
            "not-idle",
            "Session is busy: a response is still streaming.",
        ));
    }
    Ok(state)
}

/// Shared apply path for user role switches and the settle-time reapply. Forwards OMP's native
/// `/switch @<role>` and pins only on a real change. `settings_triggered` gates the extra notice.
pub async fn apply_role_now(
    agent: &SessionAgent,
    role: &str,
    settings_triggered: bool,
    cached_model_roles: Option<&std::collections::HashMap<String, String>>,
    stale_retry: Option<&tokio::sync::OnceCell<std::collections::HashMap<String, String>>>,
) -> Result<Value, AgentError> {
    // Callers do not check characters, so this stops free text reaching OMP's `/switch`.
    if !is_switch_argument_token(&format!("@{role}")) {
        return Err(AgentError::new(
            "invalid-argument",
            format!("Role \"{role}\" contains characters `/switch` cannot forward."),
        ));
    }
    let before = refresh_state_or_refuse(agent).await?;
    let before_text = friendly_model_text(&before);
    agent.send_if_idle(format!("/switch @{role}"), None).await?;
    let after = agent.refresh_from_state().await.map_err(|err| {
        AgentError::new(
            "prompt-failed",
            format!("Could not confirm the role switch: {}", err.message),
        )
    })?;
    let after_model = model_value(&after).ok_or_else(|| {
        AgentError::new(
            "prompt-failed",
            "Could not read the model after switching roles.",
        )
    })?;
    let before_model = model_value(&before);
    if before_model.as_ref() == Some(&after_model) {
        // A role already live is a valid no-op, so re-choosing it still un-pins.
        let fetched;
        let model_roles = match cached_model_roles {
            Some(map) => map,
            None => {
                fetched = crate::ipc::model_roles::get_model_roles_reliable()
                    .await
                    .map_err(|err| AgentError::new("omp-probe-failed", err.to_string()))?;
                &fetched
            }
        };
        let mut role_resolves_to_current = model_support::resolve_role_selector(model_roles, role)
            .is_some_and(|selector| selector_matches_model(selector, &after_model));
        // Re-read a cached map at most once per sweep; a failed re-read surfaces via `?`.
        if !role_resolves_to_current && cached_model_roles.is_some() {
            if let Some(cell) = stale_retry {
                let fresh = cell
                    .get_or_try_init(crate::ipc::model_roles::get_model_roles_reliable)
                    .await
                    .map_err(|err| AgentError::new("omp-probe-failed", err.to_string()))?;
                role_resolves_to_current = model_support::resolve_role_selector(fresh, role)
                    .is_some_and(|selector| selector_matches_model(selector, &after_model));
            }
        }
        if !role_resolves_to_current {
            let message = format!(
                "Role \"{role}\" could not be applied: the model is still {}.",
                friendly_model_text(&after)
            );
            if settings_triggered {
                post_notice(agent, NoticeLevel::Error, message.clone()).await;
            }
            return Err(AgentError::new("prompt-failed", message));
        }
    }
    agent
        .with_model_state(|s| {
            s.pinned = false;
            s.pinned_seeded = true; // gate round 1 fix (LOW #9): this writer's own un-pin IS the seed
            s.current_role = Some(role.to_string());
            s.pending_role_reapply = None;
        })
        .await;
    model_support::persist_pinned(agent).await;
    if settings_triggered {
        post_notice(
            agent,
            NoticeLevel::Info,
            format!(
                "Model changed from {before_text} to {}: the \"{role}\" role was changed in Settings.",
                friendly_model_text(&after)
            ),
        )
        .await;
    }
    Ok(json!({ "model": after_model, "role": role }))
}

/// `/role <role>`, the Ctrl+R selector, and role chips land here. `role` is validated first,
/// because OMP's `/switch @<role>` silently no-ops on an unknown role.
pub async fn apply_role(
    agent: &SessionAgent,
    role: &str,
    known_roles: &[String],
) -> Result<Value, AgentError> {
    super::pending_selection::validate_known_role(role, known_roles)?;
    apply_role_now(agent, role, false, None, None).await
}

/// `/switch <arg>` and its `/model` alias. The token check runs here, so a repo-supplied
/// command named `switch` cannot bypass it. An empty `arg` only echoes the current model.
/// Always returns `{queued: false}`.
pub async fn handle_switch_text(agent: &SessionAgent, arg: &str) -> Result<Value, AgentError> {
    if !arg.is_empty() && !is_switch_argument_token(arg) {
        return Err(AgentError::new(
            "invalid-argument",
            "/switch takes a single model or role token (letters, digits, and ._:/@-, no leading -, no spaces).",
        ));
    }
    if arg.is_empty() {
        return agent.send_if_idle("/switch".to_string(), None).await;
    }
    if let Some(role) = arg.strip_prefix('@') {
        // Same validation set as `/role`, not the narrower Ctrl+R list.
        let known_roles = known_chat_role_list().await?;
        apply_role(agent, role, &known_roles).await?;
        return Ok(json!({ "queued": false }));
    }
    let before = refresh_state_or_refuse(agent).await?;
    agent.send_if_idle(format!("/switch {arg}"), None).await?;
    let after = agent.refresh_from_state().await.map_err(|err| {
        AgentError::new(
            "prompt-failed",
            format!("Could not confirm the model switch: {}", err.message),
        )
    })?;
    let after_model = model_value(&after).ok_or_else(|| {
        AgentError::new("prompt-failed", "Could not read the model after switching.")
    })?;
    let before_model = model_value(&before);
    if before_model.as_ref() == Some(&after_model) {
        // A token naming the live model is a no-op; only a non-matching token is an error.
        if !selector_matches_model(arg, &after_model) {
            return Err(AgentError::new(
                "prompt-failed",
                format!("Model unchanged: \"{arg}\" could not be resolved."),
            ));
        }
    }
    agent
        .with_model_state(|s| {
            s.pinned = true;
            s.pinned_seeded = true; // gate round 1 fix (LOW #9): this writer's own pin IS the seed
            s.current_role = None;
            s.pending_role_reapply = None;
        })
        .await;
    model_support::persist_pinned(agent).await;
    Ok(json!({ "queued": false }))
}
