// Unit tests for `session::model`'s pure helpers (lane RM, issues #454, #740, #741, #762, #766,
// #760): `build_role_list`, `is_switch_argument_token`, `friendly_model_text`, `model_value`.
// `#[path]`-loaded sibling of `model.rs` (excluded from `check:file-size` by its own `_tests.rs`
// name).
//
// Gate-fix (CRITICAL, tests review): this header used to claim the RPC-shaped functions
// (`set_model`, `cycle_model`, `apply_role`/`apply_role_now`, `handle_switch_text`, the
// `on_frame` reapply, `SessionManager::apply_role_change`, and every mid-turn refusal) were
// "covered by this lane's own live CDP check instead" -- that check never reached a running
// agent (`stopReason: "start-failed"`) when this claim was written, so none of those paths had
// ANY coverage at that point. The root cause (a brand-new isolated profile has no default model
// configured, so `omp --mode rpc-ui` exits before `ready`) is now fixed in
// `scripts/verify-rm-live-check.mjs` (seeds a real, if unreachable, local model first, the same
// pattern the committed RM0 probe scripts already use) and re-run against a live agent; see the
// PR body for the live-check evidence this round records. The RPC-shaped functions themselves
// still have no unit coverage here: they need a live `SessionAgent` with a running `omp` process
// to exercise meaningfully (a fake `OmpProcess` executor seam does not exist in this build), so
// they are covered by that live check, not by a unit test in this file.

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
fn is_switch_argument_token_rejects_a_leading_dash_flag_like_argument() {
    // Gate-fix (HIGH, #762 acceptance: "/switch cannot be given ... a flag"): `-` is still an
    // allowed INTERIOR character (`claude-sonnet-5.5` must keep working), so this is a
    // leading-character rule, not a charset removal.
    assert!(!is_switch_argument_token("--help"));
    assert!(!is_switch_argument_token("-x"));
}

#[test]
fn is_switch_argument_token_accepts_an_interior_dash() {
    assert!(is_switch_argument_token("claude-sonnet-5.5"));
}

#[test]
fn is_switch_argument_token_rejects_an_over_long_argument() {
    let long = "a".repeat(257);
    assert!(!is_switch_argument_token(&long));
}

#[test]
fn is_switch_argument_token_accepts_the_maximum_length() {
    let max = "a".repeat(256);
    assert!(is_switch_argument_token(&max));
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
// friendly_model_text / model_value
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

#[test]
fn model_value_is_none_for_a_missing_model_field() {
    assert_eq!(model_value(&serde_json::json!({})), None);
}

#[test]
fn model_value_is_none_for_an_explicit_null_model() {
    assert_eq!(model_value(&serde_json::json!({ "model": null })), None);
}

#[test]
fn model_value_is_some_for_a_real_model_object() {
    let data = serde_json::json!({ "model": { "provider": "p", "id": "i" } });
    assert_eq!(
        model_value(&data),
        Some(serde_json::json!({ "provider": "p", "id": "i" }))
    );
}
