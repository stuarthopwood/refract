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

// -------------------------------------------------------------------------------------------
// `resume_session_core`/`attach_snapshot_decision` against plain fakes (gate-fix, code review +
// test-review HIGH): the whole point of the `ResumableAgent`/`AttachableAgent` seam is that
// these decision bodies are testable without a real `SessionAgent`/process. `StdMutex` (not a
// bare `Cell`) only because the trait methods take `&self` through a shared reference the real
// adapter also uses that way; `#[tokio::test]`'s default current-thread runtime never touches
// these fakes from a second OS thread, so the extra lock is cheap insurance, not a requirement.

struct FakeResumableAgent {
    status: SessionStatus,
    status_after_start: Option<SessionStatus>,
    stop_reason: Option<String>,
    terminated_unexpectedly: bool,
    send_fails: bool,
    start_called: StdMutex<bool>,
    notify_called: StdMutex<bool>,
    send_called: StdMutex<bool>,
}

impl ResumableAgent for FakeResumableAgent {
    async fn status(&self) -> SessionStatus {
        if *self.start_called.lock().unwrap() {
            self.status_after_start.unwrap_or(self.status)
        } else {
            self.status
        }
    }

    async fn stop_reason(&self) -> Option<String> {
        self.stop_reason.clone()
    }

    async fn resolve_termination(&self) -> TerminationDetectionResult {
        TerminationDetectionResult {
            terminated_unexpectedly: self.terminated_unexpectedly,
            ..Default::default()
        }
    }

    async fn start(&self) -> Result<(), AgentError> {
        *self.start_called.lock().unwrap() = true;
        Ok(())
    }

    async fn notify_list_changed(&self) {
        *self.notify_called.lock().unwrap() = true;
    }

    async fn send_resume_instruction(&self) -> Result<(), AgentError> {
        *self.send_called.lock().unwrap() = true;
        if self.send_fails {
            Err(AgentError::new("prompt-failed", "boom"))
        } else {
            Ok(())
        }
    }
}

fn fake_resumable(
    status: SessionStatus,
    status_after_start: Option<SessionStatus>,
    stop_reason: Option<&str>,
    terminated_unexpectedly: bool,
    send_fails: bool,
) -> FakeResumableAgent {
    FakeResumableAgent {
        status,
        status_after_start,
        stop_reason: stop_reason.map(str::to_string),
        terminated_unexpectedly,
        send_fails,
        start_called: StdMutex::new(false),
        notify_called: StdMutex::new(false),
        send_called: StdMutex::new(false),
    }
}

#[tokio::test]
async fn resume_session_core_refuses_busy_while_another_call_holds_the_lock() {
    let id = format!("test-session-{}", uuid::Uuid::new_v4());
    let _guard = try_lock_resuming(&id).expect("first claim must succeed");
    let agent = fake_resumable(
        SessionStatus::Stopped,
        None,
        Some("agent-exited"),
        false,
        false,
    );
    let result = resume_session_core(&agent, &id, false).await;
    assert!(matches!(result, Err(ResumeCoreError::Refused("busy"))));
    assert!(
        !*agent.start_called.lock().unwrap(),
        "a refused-busy call must never touch the agent at all"
    );
}

#[tokio::test]
async fn resume_session_core_refuses_when_not_eligible_without_starting_the_agent() {
    let id = format!("test-session-{}", uuid::Uuid::new_v4());
    let agent = fake_resumable(
        SessionStatus::Working,
        None,
        Some("agent-exited"),
        false,
        false,
    );
    let result = resume_session_core(&agent, &id, false).await;
    assert!(matches!(
        result,
        Err(ResumeCoreError::Refused("not-stopped"))
    ));
    assert!(!*agent.start_called.lock().unwrap());
}

#[tokio::test]
async fn resume_session_core_refuses_an_archived_session() {
    let id = format!("test-session-{}", uuid::Uuid::new_v4());
    let agent = fake_resumable(
        SessionStatus::Stopped,
        None,
        Some("agent-exited"),
        false,
        false,
    );
    let result = resume_session_core(&agent, &id, true).await;
    assert!(matches!(
        result,
        Err(ResumeCoreError::Refused("not-eligible"))
    ));
    assert!(!*agent.start_called.lock().unwrap());
}

#[tokio::test]
async fn resume_session_core_starts_notifies_and_sends_when_eligible_and_restart_succeeds() {
    let id = format!("test-session-{}", uuid::Uuid::new_v4());
    let agent = fake_resumable(
        SessionStatus::Stopped,
        Some(SessionStatus::Working),
        Some("agent-exited"),
        false,
        false,
    );
    let result = resume_session_core(&agent, &id, false).await;
    assert!(
        result.is_ok(),
        "an eligible resume whose restart succeeds must succeed"
    );
    assert!(*agent.start_called.lock().unwrap());
    assert!(*agent.notify_called.lock().unwrap());
    assert!(
        *agent.send_called.lock().unwrap(),
        "a Session that came back must get the resume instruction"
    );
}

#[tokio::test]
async fn resume_session_core_never_sends_when_the_restart_itself_fails() {
    let id = format!("test-session-{}", uuid::Uuid::new_v4());
    let agent = fake_resumable(
        SessionStatus::Stopped,
        Some(SessionStatus::Stopped),
        Some("agent-exited"),
        false,
        false,
    );
    let result = resume_session_core(&agent, &id, false).await;
    assert!(result.is_ok(), "a failed restart is still Ok, just unsent");
    assert!(*agent.start_called.lock().unwrap());
    assert!(
        !*agent.send_called.lock().unwrap(),
        "never send the resume instruction into a Session that did not actually come back"
    );
}

#[tokio::test]
async fn resume_session_core_propagates_a_send_failure_as_prompt_failed() {
    let id = format!("test-session-{}", uuid::Uuid::new_v4());
    let agent = fake_resumable(
        SessionStatus::Stopped,
        Some(SessionStatus::Working),
        Some("agent-exited"),
        false,
        true,
    );
    let result = resume_session_core(&agent, &id, false).await;
    match result {
        Err(ResumeCoreError::PromptFailed(message)) => assert_eq!(message, "boom"),
        other => panic!("expected PromptFailed, got is_ok={}", other.is_ok()),
    }
}

struct FakeAttachableAgent {
    status: SessionStatus,
    stop_reason: Option<String>,
    terminated_unexpectedly: bool,
    start_called: StdMutex<bool>,
    notify_called: StdMutex<bool>,
}

impl AttachableAgent for FakeAttachableAgent {
    async fn status(&self) -> SessionStatus {
        self.status
    }

    async fn stop_reason(&self) -> Option<String> {
        self.stop_reason.clone()
    }

    async fn resolve_termination(&self) -> TerminationDetectionResult {
        TerminationDetectionResult {
            terminated_unexpectedly: self.terminated_unexpectedly,
            ..Default::default()
        }
    }

    async fn start(&self) -> Result<(), AgentError> {
        *self.start_called.lock().unwrap() = true;
        Ok(())
    }

    async fn notify_list_changed(&self) {
        *self.notify_called.lock().unwrap() = true;
    }
}

fn fake_attachable(
    status: SessionStatus,
    stop_reason: Option<&str>,
    terminated_unexpectedly: bool,
) -> FakeAttachableAgent {
    FakeAttachableAgent {
        status,
        stop_reason: stop_reason.map(str::to_string),
        terminated_unexpectedly,
        start_called: StdMutex::new(false),
        notify_called: StdMutex::new(false),
    }
}

#[tokio::test]
async fn attach_snapshot_decision_is_none_and_never_starts_when_not_stopped() {
    let agent = fake_attachable(SessionStatus::Working, Some("agent-exited"), false);
    let detection = attach_snapshot_decision(&agent, false).await;
    assert!(detection.is_none());
    assert!(!*agent.start_called.lock().unwrap());
}

#[tokio::test]
async fn attach_snapshot_decision_force_start_restarts_even_an_agent_exited_reason() {
    let agent = fake_attachable(SessionStatus::Stopped, Some("agent-exited"), false);
    let detection = attach_snapshot_decision(&agent, true).await;
    assert!(detection.is_some());
    assert!(
        *agent.start_called.lock().unwrap(),
        "sessions.recover (force_start) restarts regardless of stopReason"
    );
    assert!(*agent.notify_called.lock().unwrap());
}

#[tokio::test]
async fn attach_snapshot_decision_passive_open_never_auto_starts_an_agent_exited_session() {
    let agent = fake_attachable(SessionStatus::Stopped, Some("agent-exited"), false);
    let detection = attach_snapshot_decision(&agent, false).await;
    assert!(
        detection.is_some(),
        "the snapshot still reports the FRESH detection either way"
    );
    assert!(
        !*agent.start_called.lock().unwrap(),
        "a passive open must never auto-start a crashed/failed agent (FR-034)"
    );
}

#[tokio::test]
async fn attach_snapshot_decision_passive_open_auto_starts_when_nothing_is_wrong() {
    let agent = fake_attachable(SessionStatus::Stopped, Some("not-started"), false);
    let detection = attach_snapshot_decision(&agent, false).await;
    assert!(detection.is_some());
    assert!(*agent.start_called.lock().unwrap());
    assert!(*agent.notify_called.lock().unwrap());
}
