// Model-role pure helpers and the Conversation-file role lookup (lane RM, issues #454, #740,
// #741, #762, #766, #760): split out of `model.rs` itself (gate-fix: pushed `model.rs` over this
// build's 600-line cap) into its own file, the same pattern `agent/lane_support.rs` already uses
// for `agent/mod.rs`. Everything here backs the user-initiated actions that stay in `model.rs`
// (`set_model`, `cycle_model`, `apply_role_now`, `handle_switch_text`); `current_selection` and
// `known_role_list` are also called directly from outside this module's own tree (`ipc::model`,
// `ipc::chat`, `session::manager`, `session::agent::commands`/`agent::mod`), so `model.rs`
// re-exports them at its own path unchanged rather than every caller switching to a new one.

use serde_json::Value;

use crate::omp::transcript::{NoticeLevel, TranscriptItem};

use super::super::agent::{AgentError, SessionAgent};

/// Gate-fix (HIGH, #762): `/switch`'s own verified argument shape is a single TOKEN, not an
/// arbitrary string -- caps length the same way `agent::mod`'s own `MAX_MODEL_FIELD_LENGTH`
/// bounds a model field elsewhere in this build.
const MAX_SWITCH_ARGUMENT_LENGTH: usize = 256;

/// Issue #766, decided by Stuart 2026-10-13: Ctrl+R (and `/role` bare) cycles `cycleOrder`'s
/// roles plus the literal `"plan"` role, deduplicated, `cycleOrder`'s own order preserved.
fn build_role_list(cycle_order: &[String]) -> Vec<String> {
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
/// either field is missing -- a get_state `model` object this lane cannot resolve to a selector
/// is never treated as matching one (gate-fix, HIGH): see `apply_role_now`/`handle_switch_text`'s
/// own same-model check in `model.rs`.
pub(in crate::session) fn model_selector_string(model: &Value) -> Option<String> {
    let provider = model.get("provider").and_then(Value::as_str)?;
    let id = model.get("id").and_then(Value::as_str)?;
    Some(format!("{provider}/{id}"))
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

/// Reads the Session's own current Conversation file (if any) for its LATEST `model_change`
/// entry's `role` (FINDINGS item 51: `set_model`/`open_session`-override always write an
/// explicit `role:"default"`; `cycle_model` omits `role` entirely -- both reconstruct to
/// `"default"` per the same finding). `None` when the file has no `model_change` entry at all
/// (nothing has ever touched this Session's model this Conversation) or cannot be read --
/// callers must not guess `"default"` for that case (#741: "if the role cannot be established,
/// show nothing rather than a guess"). Reads the whole file once (gate-fix note: cached by the
/// caller into `State.current_role` so this never repeats for the same Session/Conversation; a
/// NOT-found result is cached too, by path, in `State.role_probed_path` -- gate-fix HIGH/perf).
async fn read_role_from_session_file(conversation_path: &str) -> Option<String> {
    let content = tokio::fs::read_to_string(conversation_path).await.ok()?;
    let mut latest: Option<String> = None;
    for line in content.lines() {
        let line = line.trim();
        // Gate-fix (HIGH, perf): skip the `serde_json::from_str` parse entirely for the common
        // case -- most lines in a long-running Conversation are not `model_change` entries, and
        // a plain substring scan is far cheaper than parsing JSON just to discard it.
        if line.is_empty() || !line.contains("model_change") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("model_change") {
            latest = Some(
                value
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("default")
                    .to_string(),
            );
        }
    }
    latest
}

/// Read access to this lane's own per-Session state, for `ipc::model` (the role selector's
/// listing), `session::manager` (the #740 propagation sweep), and `ipc::chat` (the `/role`
/// interception) -- all outside this module's own tree, so this wraps `with_model_state` in a
/// `pub` function rather than widening the `State` struct's own fields to `pub`. Lazily seeds
/// `current_role` from the Session's own Conversation file on the first call this run (gate-fix,
/// HIGH, #741: never a guessed `"default"`), then returns the cached value on every later call.
/// Gate-fix (HIGH, perf): a Session whose Conversation has no `model_change` entry at all (the
/// common case -- nobody has ever touched its model/role) used to re-read and re-parse the WHOLE
/// file on every call (every `sessions.list()` poll, one Session at a time); the negative result
/// is now cached too, keyed by the probed path, so a later call for the SAME Conversation returns
/// immediately, while a genuinely new Conversation (a different path) is still probed fresh.
pub async fn current_selection(agent: &SessionAgent) -> (bool, Option<String>) {
    let (pinned, cached_role) = agent
        .with_model_state(|s| (s.pinned, s.current_role.clone()))
        .await;
    if pinned || cached_role.is_some() {
        return (pinned, cached_role);
    }
    let Some(path) = agent.current_conversation_path().await else {
        return (pinned, None);
    };
    let already_probed = agent
        .with_model_state(|s| s.role_probed_path.as_deref() == Some(path.as_str()))
        .await;
    if already_probed {
        return (pinned, None);
    }
    let role = read_role_from_session_file(&path).await;
    if let Some(role) = role.clone() {
        agent
            .with_model_state(|s| {
                if s.current_role.is_none() {
                    s.current_role = Some(role);
                }
            })
            .await;
    } else {
        agent
            .with_model_state(|s| s.role_probed_path = Some(path.clone()))
            .await;
    }
    (pinned, role)
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
