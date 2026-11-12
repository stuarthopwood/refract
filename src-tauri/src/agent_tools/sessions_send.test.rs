use super::*;
use std::time::Duration;

fn row(id: &str, status: &str) -> Value {
    json!({ "id": id, "status": status, "archivedAt": null })
}

fn code<T: std::fmt::Debug>(r: Result<T, ToolError>) -> String {
    r.unwrap_err().code
}

#[test]
fn arguments_must_be_non_empty_and_within_32_kb() {
    assert_eq!(code(parse_args(&json!({"id": "", "text": "hi"}))), INVALID_INPUT);
    assert_eq!(code(parse_args(&json!({"id": "a", "text": "  "}))), INVALID_INPUT);
    assert_eq!(code(parse_args(&json!({"id": "a"}))), INVALID_INPUT);
    let big = "x".repeat(MAX_TEXT_BYTES + 1);
    assert_eq!(code(parse_args(&json!({"id": "a", "text": big}))), INVALID_INPUT);
    assert_eq!(parse_args(&json!({"id": "a", "text": "hi"})).unwrap(), ("a", "hi"));
}

#[test]
fn unknown_target_is_not_found() {
    assert_eq!(code(check_target(&[row("a", "idle")], "me", "zzz")), NOT_FOUND);
}

#[test]
fn own_id_is_an_invalid_target() {
    let rows = [row("me", "idle")];
    assert_eq!(code(check_target(&rows, "me", "me")), INVALID_TARGET);
}

#[test]
fn stopped_target_is_refused_with_its_status() {
    let rows = [row("t", "stopped")];
    let err = check_target(&rows, "me", "t").unwrap_err();
    assert_eq!(err.code, SESSION_NOT_RUNNING);
    assert!(err.message.contains("stopped"));
}

#[test]
fn paused_stopped_and_archived_targets_are_refused() {
    let paused = [json!({"id": "t", "status": "stopped", "pause": "paused", "archivedAt": null})];
    let err = check_target(&paused, "me", "t").unwrap_err();
    assert_eq!(err.code, SESSION_NOT_RUNNING);
    assert!(err.message.contains("paused"));
    let archived = [json!({"id": "t", "status": "idle", "archivedAt": "x"})];
    let err = check_target(&archived, "me", "t").unwrap_err();
    assert!(err.message.contains("archived"));
}

#[test]
fn running_targets_pass_including_a_live_paused_one() {
    for status in ["idle", "working", "needs-you"] {
        assert!(check_target(&[row("t", status)], "me", "t").is_ok());
    }
    let paused = [json!({"id": "t", "status": "idle", "pause": "paused", "archivedAt": null})];
    assert!(check_target(&paused, "me", "t").is_ok());
}

#[test]
fn checks_run_in_the_contract_order() {
    // Own id that is also stopped: invalid_target beats session_not_running.
    let rows = [row("me", "stopped")];
    assert_eq!(code(check_target(&rows, "me", "me")), INVALID_TARGET);
    // Unknown beats everything.
    assert_eq!(code(check_target(&rows, "me", "gone")), NOT_FOUND);
}

#[test]
fn eleventh_delivered_send_is_rate_limited_and_refusals_do_not_count() {
    let limiter = SendLimiter::default();
    let now = Instant::now();
    for _ in 0..crate::agent_tools::sessions_limit::MAX_SENDS {
        assert!(check_rate(&limiter, "a", "b", now).is_ok());
        limiter.record("a", "b", now);
    }
    let err = check_rate(&limiter, "a", "b", now).unwrap_err();
    assert_eq!(err.code, RATE_LIMITED);
    assert!(check_rate(&limiter, "a", "c", now).is_ok());
    assert!(check_rate(&limiter, "a", "b", now + Duration::from_secs(601)).is_ok());
}

#[test]
fn outcome_names_match_the_contract() {
    assert_eq!(outcome_name(MessageDelivery::Sent), "sent");
    assert_eq!(outcome_name(MessageDelivery::Queued), "queued");
    assert_eq!(outcome_name(MessageDelivery::Held), "held");
}
