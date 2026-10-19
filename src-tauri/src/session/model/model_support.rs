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

/// #741 decision 1: the FIRST time this Session's pin state is read this run (lazily, from
/// `current_selection` -- never eagerly at `SessionAgent::new`, which has no `await` and no
/// registry access of its own), folds the registry's own persisted `pinned_model` field into
/// in-memory `State.pinned` so a hand-picked model (`set_model`/`cycle_model`/a direct `/switch
/// <model>` token, all pinned BEFORE this app restart) still reads as pinned afterwards, instead
/// of resetting to `false` (and so to the `default` role) the moment the process relaunched. An
/// old `registry.json` with no `pinned_model` field at all deserialises it `false`
/// (`registry.rs`'s own `#[serde(default)]`), correctly folding in as "not pinned". Guarded by
/// `pinned_seeded` so the registry lock is only ever taken once per Session per run; a later
/// in-run pin/un-pin can never be clobbered by a stale re-seed (it persists its own value the
/// moment it happens, via `persist_pinned` below).
pub(super) async fn ensure_pin_seeded(agent: &SessionAgent) {
    let already_seeded = agent.with_model_state(|s| s.pinned_seeded).await;
    if already_seeded {
        return;
    }
    let persisted_pinned = agent
        .registry()
        .lock()
        .await
        .get_session(agent.session_id())
        .is_some_and(|session| session.pinned_model);
    agent
        .with_model_state(|s| {
            // Gate round 1 fix (LOW #9): a pin/unpin writer (`set_model`/`cycle_model`/
            // `apply_role_now`/`handle_switch_text`, all of which now also set `pinned_seeded`
            // in the SAME write) could have run while this function was awaiting the registry
            // lock above -- re-checking here, inside the SAME `with_model_state` call that
            // would otherwise write a stale `persisted_pinned` read, stops that race from
            // clobbering the writer's own fresher, already-persisted value.
            if s.pinned_seeded {
                return;
            }
            s.pinned_seeded = true;
            if persisted_pinned {
                s.pinned = true;
            }
        })
        .await;
}

/// #741 decision 1: persists the Session's own CURRENT `pinned` state (read back from state
/// itself, gate round 1 fix LOW #9 -- never a caller-supplied `bool` that could have gone stale
/// between its own write and this call) to the registry's own `pinnedModel` field --
/// best-effort, matching `thinking_level.rs`'s own `update_session` discipline (a failed write
/// only means a SUBSEQUENT restart replays the stale value once more; nothing else this run
/// depends on the write having landed, so it is never surfaced as an error to the caller of
/// `set_model`/`cycle_model`/`apply_role_now`/`handle_switch_text`). Skips the registry write
/// and the `session_list_changed` event entirely when the registry's own persisted value
/// already matches (gate round 1 fix LOW #9): `ensure_pin_seeded`'s own seed-read-then-write
/// shape would otherwise fire a write and an event on every Session's first poll even when
/// nothing about its pin ever changed.
pub(super) async fn persist_pinned(agent: &SessionAgent) {
    let current = agent.with_model_state(|s| s.pinned).await;
    let already_persisted = agent
        .registry()
        .lock()
        .await
        .get_session(agent.session_id())
        .is_some_and(|session| session.pinned_model == current);
    if already_persisted {
        return;
    }
    let patched = agent
        .registry()
        .lock()
        .await
        .update_session(
            agent.session_id(),
            crate::store::registry::SessionPatch {
                pinned_model: Some(current),
                ..Default::default()
            },
        )
        .await;
    if patched.is_ok() {
        agent.events().emit_session_list_changed();
    }
}

/// #741 decision 2: the effective role for one `model_change` entry's own JSON value.
/// `resolvedModelIsFallback` (`omp://session.md`: "marks a retry-fallback transition") overrides
/// whatever `role` this SAME entry also carries -- OMP's own automatic recovery after repeated
/// failures is not the user's saved choice, so the chip reads Fallback even if `role` still says
/// e.g. `"default"`. The reserved role name `"fallback"` (`omp://session.md`: "ephemeral")
/// doubles as the renderer's own sentinel for this (`modelRoles.ts`'s `FALLBACK_ROLE`). FINDINGS
/// item 61: never observed `true` live (a 90s probe against a connection-refused failure never
/// triggered it) -- shipped code-verified against the documented field, not a live-forced
/// observation; forcing the transition live is #650.
pub(super) fn model_change_role(value: &Value) -> String {
    if value
        .get("resolvedModelIsFallback")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return "fallback".to_string();
    }
    value
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("default")
        .to_string()
}

/// #741 decision 2 (issue text "Refresh the role... after any model change, and after a
/// fallback"): `model_changed`/`retry_fallback_succeeded` (`omp://rpc.md`'s event list) are
/// autonomous OMP events, landing OUTSIDE this lane's own set_model/apply_role_now/
/// handle_switch_text paths -- clearing the role cache here is the only way `model.rs`'s own
/// `current_selection` re-reads the Session file fresh on its next call, picking up the new
/// entry (and `resolvedModelIsFallback`, `model_change_role` above) instead of returning a stale
/// cached role forever. Called from `model.rs`'s own `on_frame` for every frame.
pub(super) async fn maybe_invalidate_role_cache(agent: &SessionAgent, frame_type: &str) {
    if frame_type != "model_changed" && frame_type != "retry_fallback_succeeded" {
        return;
    }
    agent
        .with_model_state(|s| {
            s.current_role = None;
            s.role_probed_path = None;
            // Gate round 1 fix (HIGH #2/#5): force `resolve_current_selection` to re-read the
            // Conversation file at least once even while `pinned` is true (a fresh fallback
            // entry must be able to outrank a pin), and bump the generation so a read already in
            // flight when THIS invalidation lands cannot write its own now-stale result back
            // over whatever this invalidation's own reprobe discovers next.
            s.role_needs_reprobe = true;
            s.role_generation = s.role_generation.wrapping_add(1);
        })
        .await;
}

/// Reads the Session's own current Conversation file (if any) for its LATEST `model_change`
/// entry's effective role (`model_change_role` above: `set_model`/`open_session`-override always
/// writes an explicit `role:"default"`; `cycle_model` omits `role` entirely -- both reconstruct
/// to `"default"`, FINDINGS item 51). `None` when the file has no `model_change` entry at all or
/// cannot be read -- never guessed as `"default"` (#741). Moved here from `model.rs` (gate round
/// 1, file-size): that file is at its own 600-line cap and this is a pure Session-state helper
/// this sibling file already owns the rest of.
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
            latest = Some(model_change_role(&value)); // #741 decision 2
        }
    }
    latest
}

/// `model.rs`'s own `current_selection` wraps this after `ensure_pin_seeded`. Lazily seeds
/// `current_role` from the Session's own Conversation file on the first call this run (gate-fix,
/// HIGH, #741: never a guessed `"default"`), then returns the cached value on every later call.
/// A Session whose Conversation has no `model_change` entry at all (the common case) is not
/// re-read and re-parsed on every later `sessions.list()` poll: the negative result is cached
/// too, keyed by the probed path, so a later call for the SAME Conversation returns immediately,
/// while a genuinely new Conversation (a different path) is still probed fresh.
///
/// Gate round 1 fix (HIGH #2): a PINNED Session used to return here unconditionally, so an
/// autonomous fallback entry a fresh `model_changed`/`retry_fallback_succeeded` frame wrote to
/// the Conversation file (`maybe_invalidate_role_cache` above) could never be discovered while
/// pinned -- "fallback outranks a pin" was unreachable. `role_needs_reprobe` forces one fresh
/// file read through to the probe below even though `pinned` is true; the PERSISTED pin
/// (`registry.json`'s `pinnedModel`) is never touched here or by the probe that follows -- only
/// the returned, DISPLAYED `effective_pinned` can change.
///
/// Gate round 1 fix (HIGH #5): a SECOND invalidation (bumps `role_generation`) could land WHILE
/// this file read is in flight; writing this read's now-stale result back would silently cancel
/// that newer invalidation's own request to re-probe. The write-back closure below only applies
/// (and only clears `role_needs_reprobe`) if the generation is still the one this read started
/// under.
pub(super) async fn resolve_current_selection(agent: &SessionAgent) -> (bool, Option<String>) {
    let (pinned, cached_role, needs_reprobe) = agent
        .with_model_state(|s| (s.pinned, s.current_role.clone(), s.role_needs_reprobe))
        .await;
    if !needs_reprobe && (pinned || cached_role.is_some()) {
        let effective_pinned = pinned && cached_role.as_deref() != Some("fallback"); // #741: fallback outranks a stale pin
        return (effective_pinned, cached_role);
    }
    let Some(path) = agent.current_conversation_path().await else {
        agent
            .with_model_state(|s| s.role_needs_reprobe = false)
            .await;
        return (pinned, cached_role);
    };
    let (already_probed, read_generation) = agent
        .with_model_state(|s| {
            (
                s.role_probed_path.as_deref() == Some(path.as_str()),
                s.role_generation,
            )
        })
        .await;
    if already_probed {
        agent
            .with_model_state(|s| s.role_needs_reprobe = false)
            .await;
        return (pinned, cached_role);
    }
    let role = read_role_from_session_file(&path).await;
    agent
        .with_model_state(|s| {
            if s.role_generation == read_generation {
                s.role_needs_reprobe = false;
                if let Some(role) = role.clone() {
                    if s.current_role.is_none() {
                        s.current_role = Some(role);
                    }
                } else {
                    s.role_probed_path = Some(path.clone());
                }
            }
        })
        .await;
    let effective_pinned = pinned && role.as_deref() != Some("fallback"); // #741: a fresh fallback entry outranks a pin immediately, not just on the next poll
    (effective_pinned, role)
}
