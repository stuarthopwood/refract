// Model-role pure helpers (lane RM, issues #454, #740, #741, #762, #766, #760): split out of
// `model.rs` itself (gate-fix: pushed `model.rs` over this build's 600-line cap) into its own
// sibling file. `current_selection` and `known_role_list` stay in `model.rs` itself (gate-fix,
// round 4: they are called directly from outside this module's own tree -- `ipc::model`,
// `ipc::chat`, `session::manager`, `session::agent::commands`/`agent::mod` -- so re-exporting
// them from here under `model.rs`'s own path added a layer of indirection with no benefit; only
// genuinely private/narrowly-scoped formatting and validation helpers live here).
//
// (Earlier revision wrongly compared this split to `agent/lane_support.rs`'s own: that file
// extends `SessionAgent` with inherent methods everything still calls through the SAME type, no
// re-export involved at all -- a different mechanism, not "the same pattern".)

use serde_json::Value;

use crate::omp::transcript::{NoticeLevel, TranscriptItem};

use super::super::agent::SessionAgent;

/// Gate-fix (HIGH, #762): `/switch`'s own verified argument shape is a single TOKEN, not an
/// arbitrary string -- caps length the same way `agent::mod`'s own `MAX_MODEL_FIELD_LENGTH`
/// bounds a model field elsewhere in this build.
const MAX_SWITCH_ARGUMENT_LENGTH: usize = 256;

/// Issue #766, decided by Stuart 2026-10-13: Ctrl+R (and `/role` bare) cycles `cycleOrder`'s
/// roles plus the literal `"plan"` role, deduplicated, `cycleOrder`'s own order preserved. Only
/// `model.rs`'s own `known_role_list` calls this, hence `pub(super)` rather than wider.
pub(super) fn build_role_list(cycle_order: &[String]) -> Vec<String> {
    let mut out: Vec<String> = cycle_order.to_vec();
    if !out.iter().any(|r| r == "plan") {
        out.push("plan".to_string());
    }
    out
}

/// Issue #762's own verified `/switch` argument shape: one token, no whitespace, limited to
/// letters, digits, and `._:/@-`, never starting with `-` (gate-fix, HIGH: `--help` is a
/// syntactically valid token under the bare charset alone, which let a flag-shaped argument
/// through; #762's acceptance names "a second argument or a flag" as refused, so a leading `-`
/// is refused here even though `-` is otherwise an allowed interior character, e.g.
/// `claude-sonnet-5.5`), and capped at `MAX_SWITCH_ARGUMENT_LENGTH`. Empty is handled by the
/// caller separately (a bare `/switch` is always read-only, never checked against this).
pub(in crate::session) fn is_switch_argument_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SWITCH_ARGUMENT_LENGTH
        && !value.starts_with('-')
        && !value.contains(' ')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '@' | '-'))
}

pub(in crate::session) fn friendly_model_text(get_state_data: &Value) -> String {
    let model = get_state_data.get("model");
    let name = model.and_then(|m| m.get("name")).and_then(Value::as_str);
    let provider = model
        .and_then(|m| m.get("provider"))
        .and_then(Value::as_str);
    let id = model.and_then(|m| m.get("id")).and_then(Value::as_str);
    match (name, provider, id) {
        (Some(name), ..) => name.to_string(),
        (None, Some(provider), Some(id)) => format!("{provider}/{id}"),
        (None, None, Some(id)) => id.to_string(),
        _ => "the selected model".to_string(),
    }
}

/// `None` for a missing/absent `model` field (treated as "could not confirm", gate-fix HIGH:
/// never surfaced as a successful `{model: null}` response -- see every caller in `model.rs`).
pub(in crate::session) fn model_value(get_state_data: &Value) -> Option<Value> {
    get_state_data
        .get("model")
        .cloned()
        .filter(|m| !m.is_null())
}

/// The `provider/id` form `modelRoles`' own selector strings use (confirmed live: `listRoles`'
/// own `model` field for a configured role, e.g. `"probe-fake/probe-fake-model"`). `None` when
/// either field is missing. Exported so `selector_matches_model` below and `model.rs`'s own
/// same-model checks share one definition of "what the live model's own selector form is".
pub(in crate::session) fn model_selector_string(model: &Value) -> Option<String> {
    let provider = model.get("provider").and_then(Value::as_str)?;
    let id = model.get("id").and_then(Value::as_str)?;
    Some(format!("{provider}/{id}"))
}

/// Gate-fix (round 4): does `selector` (a `modelRoles` value, OR a user-typed `/switch` token --
/// both share the same `provider/id[:thinking]` grammar, `omp://models.md` "Role aliases and
/// settings") already name the model actually live? Used when a switch's own before/after
/// `get_state` comparison shows no change, to tell a VALID no-op (the role/token already points
/// at the live model) from OMP's native `/switch` silently doing nothing on something it could
/// not resolve (FINDINGS item 53).
/// - Strips an optional `:thinkingLevel` suffix first (`omp://models.md`: "Chat-role values can
///   append a thinking selector such as `:minimal`, `:low`, `:medium`, or `:high`").
/// - Matches a bare `id` (no `provider/` prefix) against the live model's own `id` alone
///   (`omp://models.md`'s own resolution order: "exact bare id ... provider inferred").
/// - A role ALIAS (`@other-role`) or a comma-separated CANDIDATE LIST (`omp://models.md`: "Role
///   values can contain comma-separated selectors; selection uses the first available match")
///   would need a real `omp` catalog/config resolution this lane does not have here -- never
///   guessed as a match (that would wrongly accept a genuine failure) or a mismatch (that would
///   wrongly fail a genuine no-op); the caller's own unresolved-argument error path applies
///   unchanged, and this is recorded as an open problem in the PR body, not silently resolved.
pub(in crate::session) fn selector_matches_model(selector: &str, model: &Value) -> bool {
    let base = selector.split(':').next().unwrap_or(selector);
    if base.starts_with('@') || base.contains(',') {
        return false;
    }
    if Some(base) == model_selector_string(model).as_deref() {
        return true;
    }
    !base.contains('/') && Some(base) == model.get("id").and_then(Value::as_str)
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

pub(in crate::session) async fn post_notice(
    agent: &SessionAgent,
    level: NoticeLevel,
    text: String,
) {
    let id = next_notice_id(agent).await;
    agent
        .upsert_transcript_item(TranscriptItem::Notice { id, level, text })
        .await;
}
