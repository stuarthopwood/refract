// Unit tests for `session::model`'s pure helpers (lane RM, issues #454, #740, #741, #762, #766,
// #760): `build_role_list`, `is_switch_argument_token`, and `friendly_model_text`. `#[path]`-
// loaded sibling of `model.rs` (excluded from `check:file-size` by its own `_tests.rs` name).
// The RPC-shaped functions (`set_model`, `cycle_model`, `apply_role`, `handle_switch_text`) all
// need a live `SessionAgent` with a running process to exercise meaningfully and are covered by
// this lane's own live CDP check instead (no `OmpProcess` test double exists in this build).

use super::*;

// ---------------------------------------------------------------------------
// build_role_list
// ---------------------------------------------------------------------------

#[test]
fn build_role_list_appends_plan_when_absent() {
    let cycle_order = vec![
        "smol".to_string(),
        "default".to_string(),
        "slow".to_string(),
    ];
    assert_eq!(
        build_role_list(&cycle_order),
        vec![
            "smol".to_string(),
            "default".to_string(),
            "slow".to_string(),
            "plan".to_string()
        ]
    );
}

#[test]
fn build_role_list_does_not_duplicate_plan_already_in_cycle_order() {
    let cycle_order = vec!["plan".to_string(), "default".to_string()];
    assert_eq!(
        build_role_list(&cycle_order),
        vec!["plan".to_string(), "default".to_string()]
    );
}

#[test]
fn build_role_list_handles_an_empty_cycle_order() {
    assert_eq!(build_role_list(&[]), vec!["plan".to_string()]);
}

// ---------------------------------------------------------------------------
// is_switch_argument_token
// ---------------------------------------------------------------------------

#[test]
fn is_switch_argument_token_accepts_provider_slash_id() {
    assert!(is_switch_argument_token("github-copilot/claude-sonnet-5.5"));
}

#[test]
fn is_switch_argument_token_accepts_a_role_alias() {
    assert!(is_switch_argument_token("@smol"));
    assert!(is_switch_argument_token("@task"));
}

#[test]
fn is_switch_argument_token_accepts_a_thinking_suffix() {
    assert!(is_switch_argument_token(
        "github-copilot/claude-opus-5.5:high"
    ));
}

#[test]
fn is_switch_argument_token_rejects_whitespace() {
    assert!(!is_switch_argument_token("claude sonnet"));
    assert!(!is_switch_argument_token("foo bar"));
}

#[test]
fn is_switch_argument_token_rejects_a_flag_like_argument() {
    assert!(!is_switch_argument_token("--help"));
}

#[test]
fn is_switch_argument_token_rejects_empty() {
    assert!(!is_switch_argument_token(""));
}

#[test]
fn is_switch_argument_token_rejects_disallowed_punctuation() {
    assert!(!is_switch_argument_token("model;rm -rf"));
    assert!(!is_switch_argument_token("model\"quoted\""));
}

// ---------------------------------------------------------------------------
// friendly_model_text
// ---------------------------------------------------------------------------

#[test]
fn friendly_model_text_prefers_the_display_name() {
    let data = serde_json::json!({ "model": { "provider": "github-copilot", "id": "claude-sonnet-5.5", "name": "Claude Sonnet 5.5" } });
    assert_eq!(friendly_model_text(&data), "Claude Sonnet 5.5");
}

#[test]
fn friendly_model_text_falls_back_to_provider_slash_id() {
    let data =
        serde_json::json!({ "model": { "provider": "github-copilot", "id": "claude-sonnet-5.5" } });
    assert_eq!(
        friendly_model_text(&data),
        "github-copilot/claude-sonnet-5.5"
    );
}

#[test]
fn friendly_model_text_falls_back_to_a_bare_id() {
    let data = serde_json::json!({ "model": { "id": "claude-sonnet-5.5" } });
    assert_eq!(friendly_model_text(&data), "claude-sonnet-5.5");
}

#[test]
fn friendly_model_text_has_a_safe_fallback_when_model_is_missing() {
    assert_eq!(
        friendly_model_text(&serde_json::json!({})),
        "the selected model"
    );
}

// ---------------------------------------------------------------------------
// not_idle_error
// ---------------------------------------------------------------------------

#[test]
fn not_idle_error_names_the_action_and_code() {
    let err = not_idle_error("Switch the model");
    assert_eq!(err.code, "not-idle");
    assert_eq!(err.message, "Switch the model after the current turn.");
}
