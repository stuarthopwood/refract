use super::*;
use crate::agent_tools::sessions_limit::MAX_SENDS;

fn row(id: &str, status: &str) -> Value {
    json!({ "id": id, "status": status, "archivedAt": null })
}

fn code<T: std::fmt::Debug>(r: Result<T, ToolError>) -> String {
    r.unwrap_err().code
}

#[test]
fn arguments_must_be_non_empty_and_within_32_kb() {
    assert_eq!(
        code(parse_args(&json!({"id": "", "text": "hi"}))),
        INVALID_INPUT
    );
    assert_eq!(
        code(parse_args(&json!({"id": "a", "text": "  "}))),
        INVALID_INPUT
    );
    assert_eq!(code(parse_args(&json!({"id": "a"}))), INVALID_INPUT);
    let big = "x".repeat(MAX_TEXT_BYTES + 1);
    assert_eq!(
        code(parse_args(&json!({"id": "a", "text": big}))),
        INVALID_INPUT
    );
    assert_eq!(
        parse_args(&json!({"id": "a", "text": "hi"})).unwrap(),
        ("a", "hi")
    );
}

#[test]
fn unknown_target_is_not_found() {
    assert_eq!(
        code(check_target(&[row("a", "idle")], "me", "zzz")),
        NOT_FOUND
    );
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
fn a_stopped_target_that_kept_its_pause_is_refused_as_stopped() {
    let paused = [json!({"id": "t", "status": "stopped", "pause": "paused", "archivedAt": null})];
    let err = check_target(&paused, "me", "t").unwrap_err();
    assert_eq!(err.code, SESSION_NOT_RUNNING);
    assert!(err.message.contains("stopped"));
    assert!(!err.message.contains("paused"));
}

#[test]
fn archived_targets_are_refused_as_archived() {
    let archived = [json!({"id": "t", "status": "idle", "archivedAt": "x"})];
    let err = check_target(&archived, "me", "t").unwrap_err();
    assert_eq!(err.code, SESSION_NOT_RUNNING);
    assert!(err.message.contains("archived"));
}

#[test]
fn a_status_the_tools_read_as_stopped_is_refused() {
    for status in ["starting", "weird"] {
        let err = check_target(&[row("t", status)], "me", "t").unwrap_err();
        assert_eq!(err.code, SESSION_NOT_RUNNING);
        assert!(err.message.contains("stopped"));
    }
    let no_status = [json!({"id": "t", "archivedAt": null})];
    assert_eq!(
        code(check_target(&no_status, "me", "t")),
        SESSION_NOT_RUNNING
    );
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

fn rows() -> Vec<Value> {
    vec![
        json!({"id": "me", "name": "Alpha", "status": "working", "archivedAt": null}),
        json!({"id": "t", "name": "Beta", "status": "idle", "archivedAt": null}),
        row("dead", "stopped"),
    ]
}

fn plan_with<'a>(
    args: &'a Value,
    rows: &'a [Value],
    limiter: &'a SendLimiter,
) -> Result<SendPlan<'a>, ToolError> {
    plan_send(args, rows, "me", limiter, Instant::now())
}

fn used(limiter: &SendLimiter, to: &str, now: Instant) -> usize {
    // Probing takes every free slot, so each grant is handed straight back.
    let granted = (0..MAX_SENDS)
        .filter(|_| limiter.try_acquire("me", to, now).is_ok())
        .count();
    for _ in 0..granted {
        limiter.release("me", to, now);
    }
    MAX_SENDS - granted
}

#[test]
fn the_planner_checks_in_the_contract_order() {
    let limiter = SendLimiter::default();
    let rows = rows();
    let ok = json!({"id": "t", "text": "hi"});
    let now = Instant::now();
    for _ in 0..MAX_SENDS {
        std::mem::forget(plan_send(&ok, &rows, "me", &limiter, now).unwrap());
    }
    // The limit is spent for every target below, so only the check order decides each result.
    for to in ["gone", "me", "dead"] {
        for _ in 0..MAX_SENDS {
            limiter.try_acquire("me", to, now).unwrap();
        }
    }
    // Each failure beats every check after it.
    let cases = [
        (json!({"id": "t", "text": ""}), INVALID_INPUT),
        (json!({"id": "gone", "text": "hi"}), NOT_FOUND),
        (json!({"id": "me", "text": "hi"}), INVALID_TARGET),
        (json!({"id": "dead", "text": "hi"}), SESSION_NOT_RUNNING),
        (ok.clone(), RATE_LIMITED),
    ];
    for (args, expected) in cases {
        assert_eq!(code(plan_send(&args, &rows, "me", &limiter, now)), expected);
    }
}

#[test]
fn a_refused_plan_takes_no_slot() {
    let limiter = SendLimiter::default();
    let rows = rows();
    let now = Instant::now();
    for args in [
        json!({"id": "dead", "text": "hi"}),
        json!({"id": "gone", "text": "hi"}),
        json!({"id": "t"}),
    ] {
        assert!(plan_with(&args, &rows, &limiter).is_err());
    }
    assert_eq!(used(&limiter, "dead", now), 0);
    assert_eq!(used(&limiter, "gone", now), 0);
}

#[test]
fn the_sender_name_falls_back_to_the_id() {
    let limiter = SendLimiter::default();
    let args = json!({"id": "t", "text": "hi"});
    let named = rows();
    assert_eq!(plan_with(&args, &named, &limiter).unwrap().sender, "Alpha");
    let unnamed = [json!({"id": "t", "status": "idle", "archivedAt": null})];
    assert_eq!(plan_with(&args, &unnamed, &limiter).unwrap().sender, "me");
}

#[test]
fn a_failed_delivery_gives_its_slot_back_and_a_delivered_one_keeps_it() {
    let limiter = SendLimiter::default();
    let rows = rows();
    let args = json!({"id": "t", "text": "hi"});
    let plan = plan_with(&args, &rows, &limiter).unwrap();
    let slot = plan.slot;
    let failed = settle(&plan, Err(AgentError::new("prompt-failed", "boom")));
    assert_eq!(code(failed), "prompt-failed");
    assert_eq!(used(&limiter, "t", slot), 0);

    let plan = plan_with(&args, &rows, &limiter).unwrap();
    let slot = plan.slot;
    let sent = settle(&plan, Ok(MessageDelivery::Queued)).unwrap();
    assert_eq!(sent["outcome"], "queued");
    assert_eq!(used(&limiter, "t", slot), 1);
    drop(plan);
    assert_eq!(
        used(&limiter, "t", slot),
        1,
        "a settled send keeps its slot after the plan drops"
    );
}

#[test]
fn dropping_an_unsettled_plan_releases_its_slot() {
    let limiter = SendLimiter::default();
    let rows = rows();
    let args = json!({"id": "t", "text": "hi"});
    let plan = plan_with(&args, &rows, &limiter).unwrap();
    let slot = plan.slot;
    assert_eq!(used(&limiter, "t", slot), 1);
    drop(plan);
    assert_eq!(used(&limiter, "t", slot), 0);
}

#[test]
fn a_target_that_stopped_mid_send_is_session_not_running() {
    let limiter = SendLimiter::default();
    let rows = rows();
    let args = json!({"id": "t", "text": "hi"});
    let plan = plan_with(&args, &rows, &limiter).unwrap();
    let err = settle(
        &plan,
        Err(AgentError::new("agent-not-running", "no process")),
    )
    .unwrap_err();
    assert_eq!(err.code, SESSION_NOT_RUNNING);
    assert!(err.message.contains("stopped"));
}

#[test]
fn outcome_names_match_the_contract() {
    assert_eq!(outcome_name(MessageDelivery::Sent), "sent");
    assert_eq!(outcome_name(MessageDelivery::Queued), "queued");
    assert_eq!(outcome_name(MessageDelivery::Held), "held");
}
