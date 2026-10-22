// Unit tests for `session::pending_selection` (lane RM, issue #766 part A): the pending-slot
// logic and its wire shape. `#[path]`-loaded sibling of `pending_selection.rs`.
use super::*;

fn model(provider: &str, id: &str) -> Target {
    Target::Model {
        provider: provider.to_string(),
        model_id: id.to_string(),
    }
}

#[test]
fn empty_slots_have_no_wire_form() {
    assert!(PendingSelection::default().to_wire().is_none());
}

#[test]
fn a_role_serialises_with_a_null_model() {
    let pending = PendingSelection {
        target: Some(Target::Role("slow".into())),
        thinking: None,
    };
    assert_eq!(
        pending.to_wire().unwrap(),
        json!({ "role": "slow", "model": null, "thinkingLevel": null })
    );
}

#[test]
fn a_model_serialises_with_a_null_role_and_independent_thinking() {
    let pending = PendingSelection {
        target: Some(model("anthropic", "opus")),
        thinking: Some("high".into()),
    };
    assert_eq!(
        pending.to_wire().unwrap(),
        json!({
            "role": null,
            "model": { "provider": "anthropic", "modelId": "opus" },
            "thinkingLevel": "high"
        })
    );
}

#[test]
fn a_cycle_step_has_neither_role_nor_model() {
    let pending = PendingSelection {
        target: Some(Target::Cycle),
        thinking: None,
    };
    assert_eq!(
        pending.to_wire().unwrap(),
        json!({ "role": null, "model": null, "thinkingLevel": null })
    );
}

#[test]
fn take_empties_both_slots_in_one_step() {
    let mut pending = PendingSelection {
        target: Some(Target::Role("smol".into())),
        thinking: Some("low".into()),
    };
    let (target, thinking) = pending.take();
    assert_eq!(target, Some(Target::Role("smol".into())));
    assert_eq!(thinking.as_deref(), Some("low"));
    assert!(pending.to_wire().is_none());
}

#[test]
fn restore_never_overwrites_a_newer_choice() {
    let mut pending = PendingSelection {
        target: Some(Target::Role("slow".into())),
        thinking: None,
    };
    pending.restore(Some(Target::Role("smol".into())), Some("high".into()));
    assert_eq!(pending.target, Some(Target::Role("slow".into())));
    assert_eq!(pending.thinking.as_deref(), Some("high"));
}

#[test]
fn unknown_roles_are_refused_with_the_valid_list() {
    let known = vec!["default".to_string(), "slow".to_string()];
    assert!(validate_known_role("slow", &known).is_ok());
    let err = validate_known_role("fast", &known).unwrap_err();
    assert_eq!(err.code, "invalid-argument");
    assert!(err.message.contains("default, slow"));
}

#[test]
fn only_busy_or_not_running_failures_keep_the_pending_value() {
    assert!(retryable(&AgentError::new("not-idle", "x")));
    assert!(retryable(&AgentError::new("agent-not-running", "x")));
    assert!(!retryable(&AgentError::new("prompt-failed", "x")));
}
