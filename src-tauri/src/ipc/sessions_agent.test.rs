// Unit tests for `ipc::sessions_agent` (lane R3, issue #786): the pure decision functions ported
// from `canAutoStart.test.ts`, `resumeEligibility.test.ts`, and `src/shared/canResumeSession.ts`'s
// own rules -- the parts of this file's handlers that do not need a live `SessionAgent`/
// `AppState` to exercise. `#[path]`-loaded sibling of `sessions_agent.rs` (excluded from
// `check:file-size` by its own `.test.rs` name).
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
fn check_resume_eligible_refuses_a_concurrent_second_call_for_the_same_id() {
    let mut resuming = HashSet::new();
    resuming.insert("session-1".to_string());
    assert_eq!(
        check_resume_eligible(
            &resuming,
            "session-1",
            SessionStatus::Stopped,
            Some("agent-exited"),
            false,
            false
        ),
        Some("busy")
    );
}

#[test]
fn check_resume_eligible_allows_a_concurrent_call_for_a_different_id() {
    let mut resuming = HashSet::new();
    resuming.insert("session-1".to_string());
    assert_eq!(
        check_resume_eligible(
            &resuming,
            "session-2",
            SessionStatus::Stopped,
            Some("agent-exited"),
            false,
            false
        ),
        None
    );
}

#[test]
fn check_resume_eligible_refuses_once_no_longer_stopped() {
    let resuming = HashSet::new();
    assert_eq!(
        check_resume_eligible(
            &resuming,
            "session-1",
            SessionStatus::Working,
            Some("agent-exited"),
            false,
            false
        ),
        Some("not-stopped")
    );
}

#[test]
fn check_resume_eligible_re_checks_eligibility_server_side() {
    let resuming = HashSet::new();
    assert_eq!(
        check_resume_eligible(
            &resuming,
            "session-1",
            SessionStatus::Stopped,
            Some("worktree-missing"),
            true,
            false
        ),
        Some("not-eligible")
    );
    assert_eq!(
        check_resume_eligible(
            &resuming,
            "session-1",
            SessionStatus::Stopped,
            Some("start-failed"),
            true,
            false
        ),
        Some("not-eligible")
    );
    assert_eq!(
        check_resume_eligible(
            &resuming,
            "session-1",
            SessionStatus::Stopped,
            Some("not-started"),
            false,
            false
        ),
        Some("not-eligible")
    );
}

#[test]
fn check_resume_eligible_allows_the_normal_resume_case() {
    let resuming = HashSet::new();
    assert_eq!(
        check_resume_eligible(
            &resuming,
            "session-1",
            SessionStatus::Stopped,
            Some("agent-exited"),
            false,
            false
        ),
        None
    );
    assert_eq!(
        check_resume_eligible(
            &resuming,
            "session-1",
            SessionStatus::Stopped,
            Some("not-started"),
            true,
            false
        ),
        None
    );
}

#[test]
fn check_resume_eligible_refuses_an_otherwise_eligible_session_once_archived() {
    let resuming = HashSet::new();
    assert_eq!(
        check_resume_eligible(
            &resuming,
            "session-1",
            SessionStatus::Stopped,
            Some("agent-exited"),
            false,
            true
        ),
        Some("not-eligible")
    );
    assert_eq!(
        check_resume_eligible(
            &resuming,
            "session-1",
            SessionStatus::Stopped,
            Some("not-started"),
            true,
            true
        ),
        Some("not-eligible")
    );
}
