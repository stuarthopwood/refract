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
//   "Default" (that is what inherit MEANS, regardless of whether the model echoes it); any OTHER
//   requested level the model doesn't report is shown as an explicit "not reported" state over
//   the wire (`null`) rather than silently presented as if it had been confirmed. Neither branch
//   is ever an error.
//
// Gate round 2 fix (code-reviewer HIGH): `session::agent::launch::sync_from_state` used to
// unconditionally overwrite the registry's `last_thinking_level` with whatever THIS get_state
// call reported -- `None` whenever `thinkingLevel` was absent, which is every settle and every
// relaunch for `inherit` (and for any model that never reports reasoning at all). That wiped out
// a just-applied "Default" on the very next turn or app restart. Fixed in two places together:
// `sync_from_state` (launch.rs) now leaves a stored `"inherit"` UNTOUCHED on a generic settle
// when `thinkingLevel` is absent (never writes over it with `None`), so an explicitly-persisted
// "inherit" survives; this function, in turn, is now the ONLY place that ever writes
// `Some("inherit")` itself -- always writing something explicit rather than leaving it for the
// (no longer existing) generic write to fill in: `Some("inherit")` for a Default request (so it
// persists across settles and relaunches), or an explicit `None` (clearing any STALE
// previously-confirmed level) for any other request this model didn't confirm.
// Stuart's correction (supersedes an earlier, wrong version of this same fix): a Session with NO
// level ever explicitly requested, and a non-Default request the model does not confirm, BOTH
// read as "Reasoning not reported" (`modelDisplay.ts`) -- "Default" is shown ONLY once the
// developer has explicitly chosen it and it has been confirmed or implied by `inherit`'s own
// request semantics; a fresh, untouched Session is never silently presented as "Default".
//
// Gate round 3 fix (code-reviewer HIGH): round 2's "leaves `last_thinking_level` UNTOUCHED on a
// generic settle when `thinkingLevel` is absent" went too far -- it also left a stale CONCRETE
// level (e.g. "high") untouched after a model or role switch to one that doesn't report
// reasoning effort, so the Reasoning picker and radio-group kept showing the old level as if
// still current. `sync_from_state` (launch.rs) now reads the stored value under its own registry
// lock and clears it (`Some(None)`) whenever it is anything OTHER than `"inherit"` and
// `thinkingLevel` is absent; only an explicitly-persisted `"inherit"` (never a concrete level)
// survives an absent report, matching omp's own contract that the field is left out only for
// `inherit` itself or a model with no effort control at all.

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

pub(super) fn validate_level(level: &str) -> Result<(), AgentError> {
    if VALID_THINKING_LEVELS.contains(&level) {
        return Ok(());
    }
    Err(AgentError::new(
        "invalid-argument",
        format!(
            "Unknown reasoning level: {level}. Valid levels: {}",
            VALID_THINKING_LEVELS.join(", ")
        ),
    ))
}

pub async fn set_thinking_level(agent: &SessionAgent, level: &str) -> Result<Value, AgentError> {
    validate_level(level)?;
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
    // The wire response (unchanged contract, `ipc-model.ts`'s `{ thinkingLevel: string | null }`):
    // `Some` when OMP reported it, OR when the request was `inherit` (Default is always a valid
    // outcome regardless of echo); `None` only for a non-`inherit` request the model didn't
    // confirm.
    let wire_level = reported
        .clone()
        .or_else(|| (level == "inherit").then(|| "inherit".to_string()));
    // Gate round 2 fix (code-reviewer HIGH): `sync_from_state` (launch.rs) no longer writes
    // `last_thinking_level` AT ALL when `thinkingLevel` is absent from a generic `get_state` --
    // a later settle or app relaunch must never erase what THIS call is about to store. So
    // whenever OMP didn't echo the level back, this is the ONLY place that ever persists the
    // outcome, and it must always write something explicit: `Some("inherit")` for a Default
    // request, so it survives future settles/relaunches, or an explicit `None` for any OTHER
    // request this model didn't confirm -- clearing any STALE previously-confirmed level, so a
    // failed-to-confirm switch away from a real level never keeps showing that old level as if
    // still current. (Stuart's correction: a fresh, never-touched Session and this unconfirmed
    // case read identically, "Reasoning not reported" -- `modelDisplay.ts` -- never "Default".)
    // When `reported` IS `Some`, `sync_from_state`'s own write (from this exact same state read)
    // already covers it, so no separate patch is needed here.
    if reported.is_none() {
        let stored_level = (level == "inherit").then(|| "inherit".to_string());
        let patched = agent
            .registry()
            .lock()
            .await
            .update_session(
                agent.session_id(),
                SessionPatch {
                    last_thinking_level: Some(stored_level),
                    ..Default::default()
                },
            )
            .await;
        if patched.is_ok() {
            agent.events().emit_session_list_changed();
        }
    }
    // Gate round 5 fix (Flow LOW, `agent://Arch877`): the not-confirmed branch used to drop the
    // requested level entirely ("a level this model did not report back", naming nothing) --
    // `reasoning_label(level)` is the SAME helper the confirmed branch already calls, just on
    // the originally-REQUESTED string instead of the echoed-back `wire_level`.
    let label = match &wire_level {
        Some(value) => reasoning_label(value),
        None => format!(
            "{} (not reported back by this model)",
            reasoning_label(level)
        ),
    };
    post_notice(
        agent,
        NoticeLevel::Info,
        format!("Reasoning switched to {label}."),
    )
    .await;
    Ok(json!({ "thinkingLevel": wire_level }))
}
