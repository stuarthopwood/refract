// Pure model-role helpers, split out of `model.rs` to stay under the 600-line cap.
// `is_switch_argument_token` is also called from `session::agent::commands`.

use serde_json::Value;

use crate::omp::transcript::{NoticeLevel, TranscriptItem};

use super::super::agent::SessionAgent;

/// Caps `/switch` argument length, matching `agent::mod`'s model-field bound (#762).
const MAX_SWITCH_ARGUMENT_LENGTH: usize = 256;

/// Ctrl+R cycle order: `cycleOrder`'s roles plus `"plan"`, deduplicated (#766).
pub(super) fn build_role_list(cycle_order: &[String]) -> Vec<String> {
    let mut out: Vec<String> = cycle_order.to_vec();
    if !out.iter().any(|r| r == "plan") {
        out.push("plan".to_string());
    }
    out
}

/// One `/switch` token: `[A-Za-z0-9._:/@-]`, no leading `-`, within the length cap.
/// Also used by `agent::commands`.
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

/// `None` for a missing `model` field, so a caller never reports a false success.
pub(super) fn model_value(get_state_data: &Value) -> Option<Value> {
    get_state_data
        .get("model")
        .cloned()
        .filter(|m| !m.is_null())
}

/// The `provider/id` selector form of the live model. `None` when either field is missing.
pub(super) fn model_selector_string(model: &Value) -> Option<String> {
    let provider = model.get("provider").and_then(Value::as_str)?;
    let id = model.get("id").and_then(Value::as_str)?;
    Some(format!("{provider}/{id}"))
}

/// Thinking-level suffixes stripped from a selector. Other colons, as in `llama3:8b`, are kept.
const THINKING_LEVEL_SUFFIXES: [&str; 9] = [
    "off", "minimal", "low", "medium", "high", "xhigh", "max", "auto", "inherit",
];

/// Whether `selector` (a role value or typed `/switch` token) already names the live model.
/// Deeper alias chains and candidate lists are never guessed; the caller reports them as unresolved.
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

/// OMP's chat roles minus the six workload roles excluded from the switcher (#766).
const CORE_CHAT_ROLE_IDS: [&str; 3] = ["default", "smol", "slow"];

/// Role ids never treated as custom chat roles: the model-kind and workload roles (#766).
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

/// Merges `roles` with configured core chat roles and custom `modelRoles` keys.
/// Core roles are added only when set in `modelRoles`; an unset one is refused as unknown.
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

/// Reads `cycleOrder` from a raw `omp config get` response. Errors when the value is missing.
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

/// Unset `smol`/`slow` inherit a configured `default`, as OMP does, for lookups and alias hops.
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

/// Resolves a role the same way OMP does, so a legitimate no-op switch is not reported as failed.
/// Follows one `@alias` or `*` hop only; a self-reference or deeper chain counts as unresolved.
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

/// Seeds the pin from the registry's `pinned_model` once per run, so it survives a restart.
/// Lazy, because construction has no async registry access.
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
            // Re-check inside the same write: a pin writer may have run during the registry await.
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

/// Persists the current pin to the registry, best-effort. The compare and write share one lock.
/// The change event always fires, so a role change under an unchanged pin still refreshes the chip.
pub(super) async fn persist_pinned(agent: &SessionAgent) {
    let current = agent.with_model_state(|s| s.pinned).await;
    let mut registry = agent.registry().lock().await;
    let already_persisted = registry
        .get_session(agent.session_id())
        .is_some_and(|session| session.pinned_model == current);
    if !already_persisted {
        let _ = registry
            .update_session(
                agent.session_id(),
                crate::store::registry::SessionPatch {
                    pinned_model: Some(current),
                    ..Default::default()
                },
            )
            .await;
    }
    drop(registry);
    agent.events().emit_session_list_changed();
}

/// Effective role for one `model_change` entry. A retry-fallback marker overrides the saved role.
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

/// Drops the cached role and forces a reprobe, even while pinned; bumping the generation blocks
/// stale write-backs from reads already in flight.
async fn reset_role_cache(agent: &SessionAgent) {
    agent
        .with_model_state(|s| {
            s.current_role = None;
            s.role_probed_path = None;
            s.role_needs_reprobe = true;
            s.role_generation = s.role_generation.wrapping_add(1);
        })
        .await;
}

/// Clears the role cache on autonomous model events, so the next read sees the new entry.
/// Also emits `session_list_changed`, because the renderer refreshes only on that event.
pub(super) async fn maybe_invalidate_role_cache(agent: &SessionAgent, frame_type: &str) {
    if frame_type != "model_changed" && frame_type != "retry_fallback_succeeded" {
        return;
    }
    reset_role_cache(agent).await;
    agent.events().emit_session_list_changed();
}

/// Latest `model_change` role from the Session's Conversation file. `None` when absent or unreadable.
async fn read_role_from_session_file(conversation_path: &str) -> Option<String> {
    let content = tokio::fs::read_to_string(conversation_path).await.ok()?;
    let mut latest: Option<String> = None;
    for line in content.lines() {
        let line = line.trim();
        // Skip JSON parsing for the common case: most lines are not `model_change` entries.
        if line.is_empty() || !line.contains("model_change") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("model_change") {
            latest = Some(model_change_role(&value));
        }
    }
    latest
}

/// The Session's role, probed once from its Conversation file and cached.
/// A pinned Session still re-probes after an invalidation; stale write-backs are dropped.
pub(super) async fn resolve_current_selection(agent: &SessionAgent) -> (bool, Option<String>) {
    let (pinned, cached_role, needs_reprobe, entry_generation) = agent
        .with_model_state(|s| {
            (
                s.pinned,
                s.current_role.clone(),
                s.role_needs_reprobe,
                s.role_generation,
            )
        })
        .await;
    if !needs_reprobe && (pinned || cached_role.is_some()) {
        // A fallback role outranks a stale pin.
        let effective_pinned = pinned && cached_role.as_deref() != Some("fallback");
        return (effective_pinned, cached_role);
    }
    let Some(path) = agent.current_conversation_path().await else {
        agent
            .with_model_state(|s| {
                if s.role_generation == entry_generation {
                    s.role_needs_reprobe = false;
                }
            })
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
            .with_model_state(|s| {
                if s.role_generation == entry_generation {
                    s.role_needs_reprobe = false;
                }
            })
            .await;
        return (pinned, cached_role);
    }
    let role = read_role_from_session_file(&path).await;
    let (state_pinned, state_role) = agent
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
            (s.pinned, s.current_role.clone())
        })
        .await;
    let effective_pinned = state_pinned && state_role.as_deref() != Some("fallback");
    (effective_pinned, state_role)
}

/// The role a freshly launched process runs on: the Conversation file's latest entry, else the
/// configured `default`, which OMP starts on. A pinned Session never claims a role (#1878).
pub(super) fn role_after_launch(pinned: bool, probed: Option<String>) -> Option<String> {
    if pinned {
        return None;
    }
    Some(probed.unwrap_or_else(|| "default".to_string()))
}

/// Reads the Session's role as its process starts or resumes, so the composer chip names it from
/// the first paint instead of waiting for a later `model_change` frame (#1878).
pub(super) async fn seed_role_at_launch(agent: &SessionAgent) {
    ensure_pin_seeded(agent).await;
    // A new process lifetime re-reads the file; bumping the generation drops any stale write-back.
    reset_role_cache(agent).await;
    let (pinned, probed) = resolve_current_selection(agent).await;
    if let Some(role) = role_after_launch(pinned, probed) {
        agent
            .with_model_state(|s| {
                if s.current_role.is_none() {
                    s.current_role = Some(role);
                }
            })
            .await;
    }
    agent.events().emit_session_list_changed();
}

#[cfg(test)]
mod launch_role_tests {
    use super::role_after_launch;

    #[test]
    fn fresh_session_runs_on_the_default_role() {
        assert_eq!(role_after_launch(false, None).as_deref(), Some("default"));
    }

    #[test]
    fn resumed_session_keeps_the_role_its_file_names() {
        assert_eq!(
            role_after_launch(false, Some("slow".into())).as_deref(),
            Some("slow")
        );
    }

    #[test]
    fn pinned_session_claims_no_role() {
        assert_eq!(role_after_launch(true, Some("slow".into())), None);
        assert_eq!(role_after_launch(true, None), None);
    }
}
