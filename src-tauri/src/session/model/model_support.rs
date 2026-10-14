// Model-role pure helpers (lane RM, issues #454, #740, #741, #762, #766, #760): split out of
// `model.rs` itself (gate-fix: pushed `model.rs` over this build's 600-line cap) into its own
// sibling file. `current_selection` and `known_role_list` stay in `model.rs` itself: both are
// called directly from outside this module's own tree (`ipc::model`, `ipc::chat`,
// `session::manager`, `session::agent::commands`/`agent::mod`), so re-exporting them from here
// under `model.rs`'s own path would add a layer of indirection with no benefit.
//
// `is_switch_argument_token` is the ONE helper here `model.rs` itself does NOT exclusively own:
// `session::agent::commands`'s own `classify_against_builtin` also calls it directly through
// THIS module's own path (`crate::session::model::model_support::is_switch_argument_token`,
// `mod model_support` is `pub(in crate::session)` in `model.rs` for exactly this), rather than
// through a re-export `model.rs` would otherwise have to carry. Every other helper below is
// `pub(super)`: used only by `model.rs` itself, never re-exported, never imported elsewhere.
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
/// `pub(in crate::session)`: `session::agent::commands`'s own `classify_against_builtin` also
/// calls this directly, through this module's own path.
pub(in crate::session) fn is_switch_argument_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SWITCH_ARGUMENT_LENGTH
        && !value.starts_with('-')
        && !value.contains(' ')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '@' | '-'))
}

pub(super) fn friendly_model_text(get_state_data: &Value) -> String {
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
pub(super) fn model_value(get_state_data: &Value) -> Option<Value> {
    get_state_data
        .get("model")
        .cloned()
        .filter(|m| !m.is_null())
}

/// The `provider/id` form `modelRoles`' own selector strings use (confirmed live: `listRoles`'
/// own `model` field for a configured role, e.g. `"probe-fake/probe-fake-model"`). `None` when
/// either field is missing. Exported so `selector_matches_model` below and `model.rs`'s own
/// same-model checks share one definition of "what the live model's own selector form is".
pub(super) fn model_selector_string(model: &Value) -> Option<String> {
    let provider = model.get("provider").and_then(Value::as_str)?;
    let id = model.get("id").and_then(Value::as_str)?;
    Some(format!("{provider}/{id}"))
}

/// `omp://rpc.md`'s own `ThinkingLevel` vocabulary -- the ONLY values a `:thinkingLevel` CLI
/// suffix (`omp://models.md`: "optional `:thinkingLevel` suffix") can take. `selector_matches_model`
/// below strips a trailing `:<suffix>` ONLY when `<suffix>` is one of these -- an id whose
/// PROVIDER uses `:` as part of the id itself (Ollama `llama3:8b`, Bedrock `...-v1:0`) is left
/// whole instead of being wrongly truncated at its own colon.
const THINKING_LEVEL_SUFFIXES: [&str; 9] = [
    "off", "minimal", "low", "medium", "high", "xhigh", "max", "auto", "inherit",
];

/// Gate-fix (round 4/5): does `selector` (a `modelRoles` value, OR a user-typed `/switch` token
/// -- both share the same `provider/id[:thinking]` grammar, `omp://models.md` "Role aliases and
/// settings") already name the model actually live? Used when a switch's own before/after
/// `get_state` comparison shows no change, to tell a VALID no-op (the role/token already points
/// at the live model) from OMP's native `/switch` silently doing nothing on something it could
/// not resolve (FINDINGS item 53).
/// - Strips a trailing `:<suffix>` ONLY when `<suffix>` is a known `ThinkingLevel`
///   (`THINKING_LEVEL_SUFFIXES` above) -- round 5 gate-fix: a bare `selector.split(':').next()`
///   wrongly truncated a provider id that itself uses `:` (Ollama `llama3:8b`, Bedrock
///   `...-v1:0`) at the FIRST colon, not just a genuine thinking-level suffix.
/// - Matches a bare `id` (no `provider/` prefix) against the live model's own `id` alone
///   (`omp://models.md`'s own resolution order: "exact bare id ... provider inferred").
/// - A role ALIAS (`@other-role`) deeper than ONE hop, or a comma-separated CANDIDATE LIST
///   (`omp://models.md`: "Role values can contain comma-separated selectors; selection uses the
///   first available match") would need a real `omp` catalog/config resolution this lane does
///   not have here -- never guessed as a match (that would wrongly accept a genuine failure) or
///   a mismatch (that would wrongly fail a genuine no-op); the caller's own unresolved-argument
///   error path applies unchanged. A SINGLE alias hop (`@<role>` or `*`) is resolved before this
///   function ever sees it -- `resolve_role_selector`, below -- so only a DEEPER chain or a
///   candidate list reaches this refusal; recorded as an open problem in the PR body, not
///   silently resolved.
pub(super) fn selector_matches_model(selector: &str, model: &Value) -> bool {
    let base = match selector.rsplit_once(':') {
        Some((head, suffix)) if THINKING_LEVEL_SUFFIXES.contains(&suffix) => head,
        _ => selector,
    };
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

pub(super) async fn post_notice(agent: &SessionAgent, level: NoticeLevel, text: String) {
    let id = next_notice_id(agent).await;
    agent
        .upsert_transcript_item(TranscriptItem::Notice { id, level, text })
        .await;
}

/// `omp://models.md`'s own "Chat roles" minus the six WORKLOAD roles #766 itself names as "not
/// conversation roles and not in the switcher" (`tiny`, `memory`, `task`, `advisor`, `vision`,
/// `commit`) -- `plan` is handled separately (`known_role_list`'s own cycleOrder+plan baseline,
/// already present in `roles` on entry).
const CORE_CHAT_ROLE_IDS: [&str; 3] = ["default", "smol", "slow"];

/// Role ids the `modelRoles`-driven addition below must NEVER treat as a CUSTOM chat role: the
/// five MODEL-KIND roles (`image`, `web`, `speech`, `dictation`, `judge`) and the six WORKLOAD
/// roles #766 excludes. A `modelRoles` key that is NEITHER of these is a genuinely CUSTOM
/// chat-role name (`omp://models.md`: "Custom role names can be introduced through
/// `modelRoles`... they use chat models"). Does NOT filter `cycleOrder` itself -- that list is
/// the user's own explicit Ctrl+R-cycling config, already adopted unfiltered as
/// `known_chat_role_list`'s own baseline (so a workload role a user puts directly in their own
/// `cycleOrder` would still pass through that path, not this one; an unlikely config in
/// practice -- `cycleOrder` is documented as a chat-model cycling list).
const NON_CHAT_ROLE_IDS: [&str; 11] = [
    "image",
    "web",
    "speech",
    "dictation",
    "judge",
    "tiny",
    "memory",
    "task",
    "advisor",
    "vision",
    "commit",
];

/// Pure merge step for `model.rs`'s own `known_chat_role_list`: `roles` (already `cycleOrder` +
/// `plan`) plus the three CORE chat roles (gate-fix, round 6, MEDIUM: ONLY when actually
/// configured in `modelRoles` -- an UNSET core role, e.g. `smol` with no `modelRoles.smol`
/// entry, is never added HERE, so it is refused as `Unknown role` at validation time UNLESS it
/// is also listed in `cycleOrder` (which includes `smol`/`default`/`slow` by its own built-in
/// default, `omp://settings.md`) -- rather than reaching `apply_role_now`'s own same-model check
/// and wrongly reporting "could not be applied" for a role this lane has no selector to compare
/// against) plus every `modelRoles` key that is not a model-kind or workload role. `pub(super)`:
/// only `known_chat_role_list` calls this.
pub(super) fn merge_chat_roles(
    mut roles: Vec<String>,
    model_roles: &std::collections::HashMap<String, String>,
) -> Vec<String> {
    for id in CORE_CHAT_ROLE_IDS {
        if model_roles.contains_key(id) && !roles.iter().any(|r| r == id) {
            roles.push(id.to_string());
        }
    }
    for key in model_roles.keys() {
        if !NON_CHAT_ROLE_IDS.contains(&key.as_str()) && !roles.iter().any(|r| r == key) {
            roles.push(key.clone());
        }
    }
    roles
}

/// Gate-fix (round 6): extracts `cycleOrder`'s own value from a raw `omp config get` response,
/// failing closed (`Err`) when the `value` field itself is missing entirely (a malformed or
/// incomplete read) -- never silently treated as an empty list the way a genuine `null` value
/// (truly unconfigured) legitimately is. `pub(super)`: only `model.rs`'s own `known_role_list`
/// calls this.
pub(super) fn parse_cycle_order_response(response: &Value) -> Result<Vec<String>, &'static str> {
    let value = response
        .get("value")
        .ok_or("omp config returned no value field for cycleOrder.")?;
    Ok(value
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default())
}

/// `omp://models.md`'s own "Role aliases and settings": "Unset `smol` and `slow` inherit an
/// explicitly configured `default` before their built-in priority lists." Used for BOTH the
/// initial role lookup and an alias hop's own target (below), so e.g. `plan: "@smol"` with
/// `smol` itself unset still resolves through to `default`, not a bare unresolved `None`.
fn direct_selector_with_fallback<'a>(
    model_roles: &'a std::collections::HashMap<String, String>,
    role: &str,
) -> Option<&'a str> {
    model_roles.get(role).map(String::as_str).or_else(|| {
        if role == "smol" || role == "slow" {
            model_roles.get("default").map(String::as_str)
        } else {
            None
        }
    })
}

/// `apply_role_now`'s own same-model check must resolve a role the SAME way OMP itself does, or
/// a genuinely unconfigured `smol`/`slow` that OMP legitimately no-ops onto the live `default`
/// model reads as a false "could not be applied" (caught live, round 8:
/// `modelRoles={"default": "..."}`, `/switch @smol` on a session already on `default`'s model).
/// `omp://models.md`: "Role aliases like `@smol` expand through `settings.modelRoles`; `*`
/// selects `@default`." `*` is routed through the IDENTICAL one-hop `@default` handling below
/// (not a separate special case): the self-reference guard and the alias/`*` filter on the hop
/// result both apply the same way to either spelling. Resolves ONE hop only -- a
/// self-referential alias or a hop target that is ALSO an alias (a deeper chain) is the cycle
/// guard: never followed, treated as unresolved rather than guessed at.
pub(super) fn resolve_role_selector<'a>(
    model_roles: &'a std::collections::HashMap<String, String>,
    role: &str,
) -> Option<&'a str> {
    let direct = direct_selector_with_fallback(model_roles, role)?;
    let target = if direct == "*" {
        "default"
    } else if let Some(target) = direct.strip_prefix('@') {
        target
    } else {
        return Some(direct);
    };
    if target == role {
        return None;
    }
    direct_selector_with_fallback(model_roles, target)
        .filter(|hop| !hop.starts_with('@') && *hop != "*")
}
