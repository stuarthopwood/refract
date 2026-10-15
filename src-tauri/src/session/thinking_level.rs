// File-size split (#564 follow-up, PLAN.md rule 11): `set_thinking_level` moved out of
// `session/model.rs` (which was back over the 600-line cap after #564's commit 1871f9b added it
// there) into its own file, declared next to `model.rs` in `session/mod.rs`.
//
// #564: the composer's Reasoning picker. Forwards OMP's `set_thinking_level` RPC. Unlike
// `set_model`/`cycle_model`, this never pins the Session or touches its tracked role (#740/#454's
// pinning rule is a model/role concept; reasoning effort is orthogonal). Refuses while working
// (`request_rpc_if_idle`, the same rule `set_model` follows).
//
// Gate round 1 fixes (2026-10-15, amended by Stuart): two code-reviewer/security-auditor
// findings, both in the post-switch read-back below.
// - `level` IS now validated against OMP's own closed `ThinkingLevel` vocabulary before anything
//   is sent, exactly like `model::apply_role` validates `role` against `known_role_list()` --
//   previously any string reached OMP unchecked.
// - OMP's `get_state` leaves `thinkingLevel` OUT of its response both for `inherit` itself
//   (`resolveThinkingLevelForModel` resolves it to `undefined`, pi-tui's own thinking module) and
//   for ANY level on a model that does not report reasoning effort at all
//   (`clampThinkingLevelForModel` likewise resolves to `undefined`) -- this used to be treated as
//   an error on a SUCCESSFUL switch (a false failure toast the user would see even though OMP had
//   already applied the change). Fixed per Stuart's amendment: `inherit` always reads back as
//   "Default" (that is what inherit MEANS, regardless of whether the model echoes it), so its
//   registry row is patched directly here rather than left null by the generic sync below; any
//   OTHER requested level the model doesn't report is shown as an explicit "not reported by this
//   model" state (`null`) rather than silently presented as if it had been confirmed. Neither
//   branch is ever an error.

use serde_json::{json, Value};

use crate::omp::transcript::NoticeLevel;
use crate::store::registry::SessionPatch;

use super::agent::{AgentError, SessionAgent};
use super::model::model_support::post_notice;
use super::model::REQUEST_TIMEOUT_MS;

/// OMP's own `ThinkingLevel` vocabulary (`omp://rpc.md`, `shared/ipc-model.ts`'s own
/// `ThinkingLevel` union) -- the ONLY values `set_thinking_level` accepts. Security audit finding
/// (gate round 1, Low): previously unvalidated, so any string reached OMP's RPC unchecked (not a
/// JSON/command-injection risk, since it only ever enters a `serde_json::json!` value, but an
/// unknown value silently resolved to nothing on OMP's side instead of being refused here, the
/// same documented gap `model::apply_role`'s own `known_role_list()` check already closes for
/// roles).
const VALID_THINKING_LEVELS: [&str; 8] = [
    "inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max",
];

/// The UI's own label for a level (mirrors `modelDisplay.ts`'s `THINKING_LEVEL_LABEL` exactly,
/// gate round 1 Low: the transcript notice previously showed the raw OMP string and said
/// "Thinking level", while the picker and its tooltip say "Reasoning" and "Extra high"/"Default"
/// -- now the same wording everywhere). Falls back to the raw value for anything outside the
/// closed set above (defensive only: `set_thinking_level` below never reaches this with such a
/// value, since it validates first).
fn reasoning_label(level: &str) -> String {
    match level {
        "inherit" => "Default".to_string(),
        "off" => "Off".to_string(),
        "minimal" => "Minimal".to_string(),
        "low" => "Low".to_string(),
        "medium" => "Medium".to_string(),
        "high" => "High".to_string(),
        "xhigh" => "Extra high".to_string(),
        "max" => "Max".to_string(),
        other => other.to_string(),
    }
}

pub async fn set_thinking_level(agent: &SessionAgent, level: &str) -> Result<Value, AgentError> {
    if !VALID_THINKING_LEVELS.contains(&level) {
        return Err(AgentError::new(
            "invalid-argument",
            format!(
                "Unknown reasoning level: {level}. Valid levels: {}",
                VALID_THINKING_LEVELS.join(", ")
            ),
        ));
    }
    let res = agent
        .request_rpc_if_idle(
            json!({ "type": "set_thinking_level", "level": level }),
            REQUEST_TIMEOUT_MS,
            "Switch the reasoning level",
        )
        .await?;
    if res.get("success").and_then(Value::as_bool) != Some(true) {
        let message = res
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Reasoning level not set.")
            .to_string();
        return Err(AgentError::new("prompt-failed", message));
    }
    let data = agent.refresh_from_state().await.map_err(|err| {
        AgentError::new(
            "prompt-failed",
            format!(
                "Reasoning level switched, but the new state could not be confirmed: {}",
                err.message
            ),
        )
    })?;
    let reported = data
        .get("thinkingLevel")
        .and_then(Value::as_str)
        .map(str::to_string);
    // `refresh_from_state`'s own `sync_from_state` already wrote the registry from THIS SAME
    // state read, via the identical `state.get("thinkingLevel")` lookup -- so for every branch
    // below except the `inherit`-not-reported one, that write already landed the same value this
    // function is about to return. Only `inherit` needs a direct patch: `sync_from_state` has no
    // "what did the picker just request" context, so without this the registry (and every later
    // read of `lastThinkingLevel`) would show "not reported" even though requesting Default
    // always succeeds by definition.
    let thinking_level = match reported {
        Some(value) => Some(value),
        None if level == "inherit" => Some("inherit".to_string()),
        None => None,
    };
    if level == "inherit" && thinking_level.as_deref() == Some("inherit") {
        let patched = agent
            .registry()
            .lock()
            .await
            .update_session(
                agent.session_id(),
                SessionPatch {
                    last_thinking_level: Some(Some("inherit".to_string())),
                    ..Default::default()
                },
            )
            .await;
        if patched.is_ok() {
            agent.events().emit_session_list_changed();
        }
    }
    let label = match &thinking_level {
        Some(value) => reasoning_label(value),
        None => "a level this model did not report back".to_string(),
    };
    post_notice(
        agent,
        NoticeLevel::Info,
        format!("Reasoning switched to {label}."),
    )
    .await;
    Ok(json!({ "thinkingLevel": thinking_level }))
}
