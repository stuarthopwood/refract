// Unit tests for `ipc::sessions_agent` (lane R3, issue #786): the pure decision functions ported
// from `canAutoStart.test.ts`, `resumeEligibility.test.ts`, and `src/shared/canResumeSession.ts`'s
// own rules, plus the atomic busy-lock (`try_lock_resuming`, gate-fix: a single `HashSet::insert`
// call used as the whole check, not a separate `contains()` then a later `insert()`).
// `#[path]`-loaded sibling of `sessions_agent.rs` (excluded from `check:file-size` by its own
// `.test.rs` name).
use super::*;

#[test]
fn can_auto_start_table() {
    // Port of `canAutoStart.test.ts`'s own `it.each` table.
    let cases: &[(Option<&str>, bool, bool)] = &[
        (None, false, true),
        (None, true, false),
        (Some("not-started"), false, true),
        (Some("not-started"), true, false),
        (Some("worktree-missing"), false, true),
        (Some("worktree-missing"), true, true),
        (Some("agent-exited"), false, false),
        (Some("agent-exited"), true, false),
        (Some("start-failed"), false, false),
        (Some("start-failed"), true, false),
    ];
    for (stop_reason, terminated_unexpectedly, expected) in cases.iter().copied() {
        assert_eq!(
            can_auto_start(stop_reason, terminated_unexpectedly),
            expected,
            "can_auto_start({stop_reason:?}, terminated_unexpectedly={terminated_unexpectedly}) -> {expected}"
        );
    }
}

#[test]
fn can_resume_session_only_when_stopped_agent_exited_or_terminated_unexpectedly_and_not_archived() {
    assert!(can_resume_session(
        SessionStatus::Stopped,
        Some("agent-exited"),
        false,
        false
    ));
    assert!(can_resume_session(
        SessionStatus::Stopped,
        Some("not-started"),
        true,
        false
    ));
    assert!(!can_resume_session(
        SessionStatus::Working,
        Some("agent-exited"),
        false,
        false
    ));
    assert!(!can_resume_session(
        SessionStatus::Stopped,
        Some("worktree-missing"),
        true,
        false
    ));
    assert!(!can_resume_session(
        SessionStatus::Stopped,
        Some("start-failed"),
        true,
        false
    ));
    assert!(!can_resume_session(
        SessionStatus::Stopped,
        Some("not-started"),
        false,
        false
    ));
    assert!(!can_resume_session(
        SessionStatus::Stopped,
        Some("agent-exited"),
        false,
        true
    ));
}

#[test]
fn check_resume_eligible_refuses_once_no_longer_stopped() {
    assert_eq!(
        check_resume_eligible(SessionStatus::Working, Some("agent-exited"), false, false),
        Some("not-stopped")
    );
}

#[test]
fn check_resume_eligible_re_checks_eligibility_server_side() {
    assert_eq!(
        check_resume_eligible(
            SessionStatus::Stopped,
            Some("worktree-missing"),
            true,
            false
        ),
        Some("not-eligible")
    );
    assert_eq!(
        check_resume_eligible(SessionStatus::Stopped, Some("start-failed"), true, false),
        Some("not-eligible")
    );
    assert_eq!(
        check_resume_eligible(SessionStatus::Stopped, Some("not-started"), false, false),
        Some("not-eligible")
    );
}

#[test]
fn check_resume_eligible_allows_the_normal_resume_case() {
    assert_eq!(
        check_resume_eligible(SessionStatus::Stopped, Some("agent-exited"), false, false),
        None
    );
    assert_eq!(
        check_resume_eligible(SessionStatus::Stopped, Some("not-started"), true, false),
        None
    );
}

#[test]
fn check_resume_eligible_refuses_an_otherwise_eligible_session_once_archived() {
    assert_eq!(
        check_resume_eligible(SessionStatus::Stopped, Some("agent-exited"), false, true),
        Some("not-eligible")
    );
    assert_eq!(
        check_resume_eligible(SessionStatus::Stopped, Some("not-started"), true, true),
        Some("not-eligible")
    );
}

#[test]
fn try_lock_resuming_refuses_a_concurrent_second_call_for_the_same_id() {
    let id = format!("test-session-{}", uuid::Uuid::new_v4());
    let first = try_lock_resuming(&id);
    assert!(first.is_some(), "the first claim must succeed");
    let second = try_lock_resuming(&id);
    assert!(
        second.is_none(),
        "a second concurrent claim for the SAME id must be refused (busy)"
    );
    drop(first);
}

#[test]
fn try_lock_resuming_allows_a_concurrent_claim_for_a_different_id() {
    let id_a = format!("test-session-a-{}", uuid::Uuid::new_v4());
    let id_b = format!("test-session-b-{}", uuid::Uuid::new_v4());
    let guard_a = try_lock_resuming(&id_a);
    let guard_b = try_lock_resuming(&id_b);
    assert!(guard_a.is_some());
    assert!(guard_b.is_some());
}

#[test]
fn try_lock_resuming_releases_on_drop_allowing_a_later_claim() {
    let id = format!("test-session-{}", uuid::Uuid::new_v4());
    {
        let _guard = try_lock_resuming(&id);
        assert!(try_lock_resuming(&id).is_none(), "still held");
    }
    assert!(
        try_lock_resuming(&id).is_some(),
        "released once the guard dropped, so a later claim succeeds"
    );
}
