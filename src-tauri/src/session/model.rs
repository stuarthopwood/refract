// Model roles (lane RM, issues #454, #740, #741, #762, #766, #760): `set_model`, `cycle_model`,
// role records, pinning, `/switch`, `/model`, `/models`, `/role`, Ctrl+R, `/plan`, custom
// commands. Pre-declared so lane RM is the only lane that ever edits this file (issue #784,
// "Pre-declare per-lane Rust files").
//
// `on_frame` is the one extension point `agent::frame`'s own `handle_frame` calls for every
// decoded frame, `on_exit` for process exit (`agent::launch`'s own `spawn_frame_listener`), and
// `on_start_progress` for the ready-wait banner (same listener) -- one call per lane module each,
// cheap and allocation-free as a no-op; lane RM adds its model behaviour inside these functions,
// never inside any file under `session/agent/`.
//
// Design summary (FINDINGS "RM0 probe", items 51-57, `omp` 18.10.1; the full reasoning is in
// this lane's PR body under "Decisions"):
// - `set_model`/`cycle_model` are session-scoped RPC calls (FINDINGS item 51/54): neither writes
//   any role string other than `"default"` (or none), and `cycle_model` steps through literal,
//   version-adjacent catalog MODELS, never `cycleOrder`'s configured roles. Both PIN the Session
//   (#740/#454's shared pinning rule).
// - A role switch (`/role`, Ctrl+R, `/switch @<role>`) is forwarded to OMP's own native
//   `/switch @<role>` text command (FINDINGS item 54: proven to resolve the role alias
//   correctly) rather than Refract re-resolving `modelRoles`/`cycleOrder` itself (constitution
//   I's preference, and the issue's own "Otherwise Refract resolves" fallback is only for if
//   this route were impossible). Because OMP's RPC surface carries no role field anywhere
//   (FINDINGS item 21/51) and whether the native text command records a role on the Session file
//   is unverified, the Session's current role is Refract's OWN record (`State.current_role`),
//   never read back from OMP.
// - Mid-turn safety is NOT provably safe (FINDINGS item 57's unnumbered closing entry: a clean
//   18.8.0 pass regressed to a provider 400 on 18.10.1 switching between two different real
//   models) -- every user-initiated switch (`set_model`, `cycle_model`, `/switch`, `/role`)
//   refuses outright while the Session is working, the same `SessionNotIdleError` pattern `/new`
//   already uses, never queues. The ONE exception is #740's own decided design for a Settings
//   role change reaching an open Session: that path queues for the Session's own next settle
//   (never refuses, since the user did not choose this moment) and is applied internally by
//   `on_frame` below, bypassing the working-check entirely (it runs only once settle has fired).
// - `/plan` is NOT built here: FINDINGS item 55 confirms no RPC route exists at all on 18.10.1
//   (no `set_mode`/`plan` command, `"plan": {"present": false}` on both a real and an isolated
//   profile) and #766 itself says plan mode must not ship as a role switch that merely claims to
//   be it. `/plan` stays in `NATIVE_RESERVED_COMMANDS` (`session::agent::commands`), refused
//   exactly as before this lane, pending #433's own spike.

use serde_json::{json, Value};

use crate::omp::process::ReadyWaitStage;
use crate::omp::transcript::{NoticeLevel, TranscriptItem};

use super::agent::{AgentError, SessionAgent, SessionStatus};

/// Mirrors `agent::mod`'s own `DEFAULT_REQUEST_TIMEOUT_MS` (private there); re-declared here
/// with the same value, same convention `omp::process.rs` itself documents for a value it does
/// not export.
const REQUEST_TIMEOUT_MS: u64 = 60_000;

/// Lane RM's own runtime state, held inside `AgentState` by `agent/mod.rs` without that file
/// ever needing to change when this lane adds a field here. Reachable through `SessionAgent`'s
/// own `with_model_state` accessor (`agent/mod.rs`).
#[derive(Default)]
pub(super) struct State {
    /// True once the Session's model was chosen directly (the composer picker's `set_model`,
    /// `cycle_model`, or a typed `/switch <model>`/`/model <model>`) rather than via a role. A
    /// later Settings role change (#740) skips a pinned Session entirely. Choosing a role again
    /// (`/role`, Ctrl+R, `/switch @<role>`) un-pins it (#766).
    pub(super) pinned: bool,
    /// The role this Session is currently "on" (#741's composer chip, #740's "is this Session
    /// following role X" test). `None` means the Session has never been explicitly switched this
    /// run and is still on whatever role it launched with -- treated as `"default"` for every
    /// comparison (every caller does `current_role.as_deref().unwrap_or("default")`). Refract's
    /// own record: OMP's RPC surface carries no role field anywhere (FINDINGS item 21/51), so
    /// this is never read back from OMP.
    pub(super) current_role: Option<String>,
    /// Set when a role-following Session is mid-turn at the moment its role's model changes in
    /// Settings (#740's decided design: "automatic at the next idle moment", never refused).
    /// Applied by `on_frame` below at the Session's own next settle, then cleared.
    pub(super) pending_role_reapply: Option<String>,
    /// Monotonic id source for this lane's own transcript notices (`upsert_transcript_item`
    /// needs a stable, unique id per row; this lane posts no OMP frame of its own to derive one
    /// from the way `apply_frame`'s internal counter does for a `notice` frame).
    notice_seq: u64,
}

/// Issue #740: outcome of `session::manager::SessionManager::apply_role_change`'s sweep over
/// every live Session after a role's config value changes, for the Settings page's own polite
/// one-line result ("Moved N Sessions..., left M pinned, K waiting for their turn to finish").
#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleChangeSummary {
    pub moved: usize,
    pub queued: usize,
    pub skipped_pinned: usize,
    pub failed: usize,
}

pub(super) async fn on_frame(agent: &SessionAgent, frame_type: &str, frame: &Value) {
    // Matches `agent::frame`'s own settle detection exactly (`"session_settled"`, or a
    // `prompt_result` whose own `sessionSettled` flag is set) -- by the time either fires,
    // `handle_turn_settled()` has already moved the Session back to `Idle` (frame.rs runs it
    // before this hook), so `apply_role_now`'s own `agent.send()` call sees an idle Session.
    let settled = frame_type == "session_settled"
        || (frame_type == "prompt_result"
            && frame.get("sessionSettled").and_then(Value::as_bool) == Some(true));
    if !settled {
        return;
    }
    let pending = agent
        .with_model_state(|s| s.pending_role_reapply.take())
        .await;
    if let Some(role) = pending {
        // Best-effort: a failed automatic reapply leaves the Session on its current model and
        // is not retried here; the next Settings change (or a manual switch) tries again.
        let _ = apply_role_now(agent, &role, true).await;
    }
}

pub(super) async fn on_exit(_agent: &SessionAgent, _code: Option<i32>, _requested: bool) {
    // No-op: nothing in this lane's state needs clearing on process exit (a resumed Session
    // reattaches to the SAME role/pin tracking, which is correct -- a pin or role choice is a
    // property of the Session, not of one process lifetime).
}

pub(super) async fn on_start_progress(
    _agent: &SessionAgent,
    _stage: ReadyWaitStage,
    _elapsed_ms: u64,
) {
    // No-op: this lane has no start-progress banner content.
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested in `model_tests.rs`).
// ---------------------------------------------------------------------------

/// Issue #766, decided by Stuart 2026-10-13: Ctrl+R (and `/role` bare) cycles `cycleOrder`'s
/// roles plus the literal `"plan"` role, deduplicated, `cycleOrder`'s own order preserved.
pub fn build_role_list(cycle_order: &[String]) -> Vec<String> {
    let mut out: Vec<String> = cycle_order.to_vec();
    if !out.iter().any(|r| r == "plan") {
        out.push("plan".to_string());
    }
    out
}

/// Issue #762's own verified `/switch` argument shape: one token, no whitespace, limited to
/// letters, digits, and `._:/@-` (`provider/id`, a bare id, a thinking suffix `:high`, or a role
/// alias `@role`). Empty is handled by the caller separately (a bare `/switch` is always
/// read-only, never checked against this).
pub fn is_switch_argument_token(value: &str) -> bool {
    !value.is_empty()
        && !value.contains(' ')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '@' | '-'))
}

fn friendly_model_text(get_state_data: &Value) -> String {
    let model = get_state_data.get("model");
    let name = model.and_then(|m| m.get("name")).and_then(Value::as_str);
    let provider = model.and_then(|m| m.get("provider")).and_then(Value::as_str);
    let id = model.and_then(|m| m.get("id")).and_then(Value::as_str);
    match (name, provider, id) {
        (Some(name), ..) => name.to_string(),
        (None, Some(provider), Some(id)) => format!("{provider}/{id}"),
        (None, None, Some(id)) => id.to_string(),
        _ => "the selected model".to_string(),
    }
}

fn not_idle_error(action: &str) -> AgentError {
    AgentError::new("not-idle", format!("{action} after the current turn."))
}

async fn is_working(agent: &SessionAgent) -> bool {
    matches!(
        agent.status().await,
        SessionStatus::Working | SessionStatus::NeedsYou
    )
}

async fn next_notice_id(agent: &SessionAgent) -> String {
    let seq = agent
        .with_model_state(|s| {
            s.notice_seq += 1;
            s.notice_seq
        })
        .await;
    format!("model-notice:{}:{seq}", agent.session_id())
}

async fn post_notice(agent: &SessionAgent, level: NoticeLevel, text: String) {
    let id = next_notice_id(agent).await;
    agent
        .upsert_transcript_item(TranscriptItem::Notice { id, level, text })
        .await;
}

/// Read access to this lane's own per-Session state, for `ipc::model` (the role selector's
/// listing) and `session::manager` (the #740 propagation sweep) -- both outside this module's
/// own tree, so this wraps `with_model_state` in a `pub` function rather than widening the
/// `State` struct's own fields to `pub`.
pub async fn current_selection(agent: &SessionAgent) -> (bool, Option<String>) {
    agent
        .with_model_state(|s| (s.pinned, s.current_role.clone()))
        .await
}

/// `cycleOrder` (read fresh every call -- it is a small, infrequently-changed config array, not
/// worth caching) plus `"plan"` (#766). Used by `/role <role>`'s own validation (FINDINGS item
/// 53's own documented gap: OMP's native `/switch @<role>` silently no-ops on an unresolvable
/// argument rather than erroring, so Refract must validate client-side first) and by the Ctrl+R
/// selector's listing.
pub async fn known_role_list() -> Result<Vec<String>, AgentError> {
    let response = crate::omp::config::get_config("cycleOrder", &[])
        .await
        .map_err(|err| AgentError::new("omp-probe-failed", err.to_string()))?;
    let cycle_order: Vec<String> = response
        .get("value")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    Ok(build_role_list(&cycle_order))
}

// ---------------------------------------------------------------------------
// User-initiated actions (composer picker, `/switch`, `/role`, Ctrl+R).
// ---------------------------------------------------------------------------

/// #454: the composer's model picker. Session-scoped only (OMP's own `set_model` description,
/// "for this session only" -- never writes `modelRoles` or any other config); pins the Session
/// and clears any tracked role. Refuses while working (see this file's header).
pub async fn set_model(
    agent: &SessionAgent,
    provider: &str,
    model_id: &str,
) -> Result<Value, AgentError> {
    if is_working(agent).await {
        return Err(not_idle_error("Switch the model"));
    }
    let res = agent
        .request_rpc(
            json!({ "type": "set_model", "provider": provider, "modelId": model_id }),
            REQUEST_TIMEOUT_MS,
        )
        .await?;
    if res.get("success").and_then(Value::as_bool) != Some(true) {
        let message = res
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Model not found.")
            .to_string();
        return Err(AgentError::new("prompt-failed", message));
    }
    agent
        .with_model_state(|s| {
            s.pinned = true;
            s.current_role = None;
            s.pending_role_reapply = None;
        })
        .await;
    let data = agent.refresh_from_state().await.unwrap_or(Value::Null);
    post_notice(
        agent,
        NoticeLevel::Info,
        format!("Model switched to {}.", friendly_model_text(&data)),
    )
    .await;
    Ok(json!({ "model": data.get("model").cloned().unwrap_or(Value::Null) }))
}

/// #454's own keyboard/toolbar cycle: steps the live Session through OMP's `cycle_model` RPC
/// command. FINDINGS item 54: this is NOT a role cycle -- it moves through literal,
/// version-adjacent catalog models unrelated to `cycleOrder`'s roles, so it pins the Session
/// exactly like `set_model` (a concrete model was just chosen, not a role). Refuses while
/// working, same rule as `set_model`.
pub async fn cycle_model(agent: &SessionAgent) -> Result<Value, AgentError> {
    if is_working(agent).await {
        return Err(not_idle_error("Switch the model"));
    }
    let res = agent
        .request_rpc(json!({ "type": "cycle_model" }), REQUEST_TIMEOUT_MS)
        .await?;
    if res.get("success").and_then(Value::as_bool) != Some(true) {
        let message = res
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Could not switch models.")
            .to_string();
        return Err(AgentError::new("prompt-failed", message));
    }
    agent
        .with_model_state(|s| {
            s.pinned = true;
            s.current_role = None;
            s.pending_role_reapply = None;
        })
        .await;
    let data = agent.refresh_from_state().await.unwrap_or(Value::Null);
    post_notice(
        agent,
        NoticeLevel::Info,
        format!("Model switched to {}.", friendly_model_text(&data)),
    )
    .await;
    Ok(json!({ "model": data.get("model").cloned().unwrap_or(Value::Null) }))
}

/// Shared apply path for every role switch (user-initiated `apply_role` below, and #740's own
/// automatic settle-time reapply). Always forwards OMP's own native `/switch @<role>` text
/// command (FINDINGS item 54; constitution I: Refract does not reimplement `modelRoles`/
/// `cycleOrder` resolution when OMP already does it) rather than calling `set_model` with a
/// selector Refract resolved itself. `settings_triggered` controls the EXTRA transcript notice
/// (#740 item 3: "Model changed from X to Y: Default was changed in Settings") -- the
/// user-initiated path gets no extra notice of its own, since OMP's `command_output` for
/// `/switch` already confirms the change ("Session-only model: ...").
pub async fn apply_role_now(
    agent: &SessionAgent,
    role: &str,
    settings_triggered: bool,
) -> Result<Value, AgentError> {
    let before_text = if settings_triggered {
        agent
            .refresh_from_state()
            .await
            .ok()
            .map(|d| friendly_model_text(&d))
    } else {
        None
    };
    agent.send(format!("/switch @{role}"), None).await?;
    agent
        .with_model_state(|s| {
            s.pinned = false;
            s.current_role = Some(role.to_string());
            s.pending_role_reapply = None;
        })
        .await;
    let after = agent.refresh_from_state().await.unwrap_or(Value::Null);
    if settings_triggered {
        let before_text = before_text.unwrap_or_else(|| "its previous model".to_string());
        post_notice(
            agent,
            NoticeLevel::Info,
            format!(
                "Model changed from {before_text} to {}: Default was changed in Settings.",
                friendly_model_text(&after)
            ),
        )
        .await;
    }
    Ok(json!({ "model": after.get("model").cloned().unwrap_or(Value::Null), "role": role }))
}

/// #766: `/role <role>`, the Ctrl+R selector, and a role chip click all land here. `role` is
/// validated against `known_roles` BEFORE anything is sent (FINDINGS item 53's documented gap:
/// OMP's own `/switch @<role>` silently no-ops on an unknown role rather than erroring). Refuses
/// while working, same rule as `set_model`/`cycle_model`.
pub async fn apply_role(
    agent: &SessionAgent,
    role: &str,
    known_roles: &[String],
) -> Result<Value, AgentError> {
    if !known_roles.iter().any(|r| r == role) {
        return Err(AgentError::new(
            "invalid-argument",
            format!("Unknown role: {role}. Valid roles: {}", known_roles.join(", ")),
        ));
    }
    if is_working(agent).await {
        return Err(not_idle_error("Switch roles"));
    }
    apply_role_now(agent, role, false).await
}

/// `/switch <arg>` and its `/model <arg>` alias (`ipc::chat` rewrites `/model` to `/switch`
/// before this ever runs; `session::agent::commands`'s own `classify_against_builtin` already
/// rejected any argument shape this does not accept). `arg` is empty for a bare, read-only
/// `/switch` (FINDINGS item 53: always just echoes the current model); a `@role` alias routes
/// through the exact same tracking `apply_role_now` uses; anything else is a direct model token
/// and pins the Session, matching the picker's own `set_model`.
pub async fn handle_switch_text(agent: &SessionAgent, arg: &str) -> Result<Value, AgentError> {
    // Conservative by design (see this file's header): refuses while working for EVERY shape,
    // including the bare read-only form, rather than relying on `agent.send()`'s own
    // `streamingBehavior: "followUp"` queuing for a local-only command OMP has never been
    // probed sending while a turn streams.
    if is_working(agent).await {
        return Err(not_idle_error("Switch the model"));
    }
    let text = if arg.is_empty() {
        "/switch".to_string()
    } else {
        format!("/switch {arg}")
    };
    let result = agent.send(text, None).await?;
    if !arg.is_empty() {
        if let Some(role) = arg.strip_prefix('@') {
            agent
                .with_model_state(|s| {
                    s.pinned = false;
                    s.current_role = Some(role.to_string());
                    s.pending_role_reapply = None;
                })
                .await;
        } else {
            agent
                .with_model_state(|s| {
                    s.pinned = true;
                    s.current_role = None;
                    s.pending_role_reapply = None;
                })
                .await;
        }
        let _ = agent.refresh_from_state().await;
    }
    Ok(result)
}

#[cfg(test)]
#[path = "model_tests.rs"]
mod tests;
