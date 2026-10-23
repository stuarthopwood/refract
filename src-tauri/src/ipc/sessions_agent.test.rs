// Unit tests for `ipc::sessions_agent` (lane R3, issue #786): the pure decision functions ported
// from `canAutoStart.test.ts`, `resumeEligibility.test.ts`, and `src/shared/canResumeSession.ts`'s
// own rules, plus the atomic busy-lock (`try_lock_resuming`, gate-fix: a single `HashSet::insert`
// call used as the whole check, not a separate `contains()` then a later `insert()`).
// `#[path]`-loaded sibling of `sessions_agent.rs` (excluded from `check:file-size` by its own
// `.test.rs` name).
use super::*;
use crate::events::EventSink;
use crate::session::SessionManager;
use crate::store::registry::RegistryStore;
use crate::store::settings::SettingsStore;
use tokio::sync::Mutex as AsyncMutex;

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
    start_fails: bool,
    /// Gate-fix (round 3, test review HIGH): simulates a concurrent archive landing WHILE
    /// `resolve_termination`'s own tail read is in flight (`resumeSession.test.ts`'s own
    /// "archived during the tail read" case) -- flipped by `resolve_termination` itself below,
    /// read by `is_archived`, so a caller that checks `is_archived` BEFORE calling
    /// `resolve_termination` would wrongly see `false` here too.
    archived_during_resolve: bool,
    archived: StdMutex<bool>,
    /// Gate-fix (round 4, test review MEDIUM): proves the upfront-`archived` short-circuit
    /// genuinely skips the tail read entirely (`resumeSession.test.ts`'s own "refuses as
    /// not-eligible for an archived Session, without reading the tail" -- never worth a 256 KiB
    /// file read for a Session a resume can never apply to).
    resolve_termination_called: StdMutex<bool>,
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
        *self.resolve_termination_called.lock().unwrap() = true;
        if self.archived_during_resolve {
            *self.archived.lock().unwrap() = true;
        }
        TerminationDetectionResult {
            terminated_unexpectedly: self.terminated_unexpectedly,
            ..Default::default()
        }
    }

    async fn is_archived(&self) -> bool {
        *self.archived.lock().unwrap()
    }

    async fn start(&self) -> Result<(), AgentError> {
        // A real yield point (gate-fix: `resume_session_core_sends_the_instruction_exactly_once_
        // under_real_concurrency` races two calls via `tokio::join!` on the SAME `#[tokio::test]`
        // current-thread runtime -- without an actual `.await` that returns `Pending` at least
        // once while the lock is held, both futures would run to completion back to back inside
        // a single poll, never actually overlapping).
        tokio::task::yield_now().await;
        *self.start_called.lock().unwrap() = true;
        if self.start_fails {
            return Err(AgentError::new("spawn-failed", "spawn ENOENT"));
        }
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
    start_fails: bool,
) -> FakeResumableAgent {
    fake_resumable_with_archive_race(
        status,
        status_after_start,
        stop_reason,
        terminated_unexpectedly,
        send_fails,
        start_fails,
        false,
    )
}

#[allow(clippy::too_many_arguments)]
fn fake_resumable_with_archive_race(
    status: SessionStatus,
    status_after_start: Option<SessionStatus>,
    stop_reason: Option<&str>,
    terminated_unexpectedly: bool,
    send_fails: bool,
    start_fails: bool,
    archived_during_resolve: bool,
) -> FakeResumableAgent {
    FakeResumableAgent {
        status,
        status_after_start,
        stop_reason: stop_reason.map(str::to_string),
        terminated_unexpectedly,
        send_fails,
        start_fails,
        archived_during_resolve,
        archived: StdMutex::new(false),
        resolve_termination_called: StdMutex::new(false),
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
async fn resume_session_core_sends_the_instruction_exactly_once_under_real_concurrency() {
    // Port of `resumeSession.test.ts`'s own "sends the instruction exactly once under real
    // concurrency (two calls started before either resolves)": the sibling test above pre-claims
    // the guard itself before calling `resume_session_core`, which only proves the function
    // checks an ALREADY-held lock correctly -- `tokio::join!` instead races the function's own
    // internal `try_lock_resuming` call twice for the SAME id, the stronger property this TS
    // case name describes.
    let id = format!("test-session-{}", uuid::Uuid::new_v4());
    let agent = fake_resumable(
        SessionStatus::Stopped,
        Some(SessionStatus::Working),
        Some("agent-exited"),
        false,
        false,
        false,
    );
    let (first, second) = tokio::join!(
        resume_session_core(&agent, &id, false),
        resume_session_core(&agent, &id, false)
    );
    let outcomes = [first, second];
    let busy_count = outcomes
        .iter()
        .filter(|r| matches!(r, Err(ResumeCoreError::Refused("busy"))))
        .count();
    let ok_count = outcomes.iter().filter(|r| r.is_ok()).count();
    assert_eq!(
        busy_count, 1,
        "exactly one concurrent call must be refused busy"
    );
    assert_eq!(ok_count, 1, "exactly one concurrent call must proceed");
    assert!(
        *agent.send_called.lock().unwrap(),
        "the single call that won the lock must still send the resume instruction"
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
async fn resume_session_core_refuses_an_archived_session_without_reading_the_tail() {
    // Port of `resumeSession.test.ts`'s own "refuses as not-eligible for an archived Session,
    // without reading the tail" (Main gate round 4 MEDIUM): never worth a 256 KiB Conversation
    // read for a Session a resume can never apply to -- the upfront `archived` parameter must
    // short-circuit BEFORE `resolve_termination` is ever called, not merely refuse afterward.
    let id = format!("test-session-{}", uuid::Uuid::new_v4());
    let agent = fake_resumable(
        SessionStatus::Stopped,
        None,
        Some("agent-exited"),
        false,
        false,
        false,
    );
    let result = resume_session_core(&agent, &id, true).await;
    assert!(matches!(
        result,
        Err(ResumeCoreError::Refused("not-eligible"))
    ));
    assert!(!*agent.start_called.lock().unwrap());
    assert!(
        !*agent.resolve_termination_called.lock().unwrap(),
        "an already-archived Session must never trigger the tail read at all"
    );
    assert!(
        try_lock_resuming(&id).is_some(),
        "the busy lock must be released even on this early-return path"
    );
}

#[tokio::test]
async fn resume_session_core_refuses_when_archived_during_the_tail_read() {
    // Gate-fix (round 3, test review HIGH): the sibling test above passes `archived=true` as a
    // snapshot from BEFORE `resolve_termination`'s own tail read starts -- it cannot prove the
    // race where the archive instead lands DURING that await. `archived_during_resolve` flips
    // `FakeResumableAgent`'s own `is_archived` flag from inside `resolve_termination` itself, so
    // this proves `resume_session_core`'s own fresh `is_archived().await` re-check (not the
    // stale `archived` snapshot parameter) is what catches it.
    let id = format!("test-session-{}", uuid::Uuid::new_v4());
    let agent = fake_resumable_with_archive_race(
        SessionStatus::Stopped,
        Some(SessionStatus::Working),
        Some("agent-exited"),
        false,
        false,
        false,
        true,
    );
    let result = resume_session_core(&agent, &id, false).await;
    assert!(matches!(
        result,
        Err(ResumeCoreError::Refused("not-eligible"))
    ));
    assert!(
        !*agent.start_called.lock().unwrap(),
        "must never start the agent for a Session it is about to report as ineligible"
    );
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
    // Port of `resumeSession.test.ts`'s own "releases the lock after agent.start() resolves but
    // the resulting snapshot is still stopped".
    let id = format!("test-session-{}", uuid::Uuid::new_v4());
    let agent = fake_resumable(
        SessionStatus::Stopped,
        Some(SessionStatus::Stopped),
        Some("agent-exited"),
        false,
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
    assert!(
        try_lock_resuming(&id).is_some(),
        "the busy lock must be released once this call has returned"
    );
}

#[tokio::test]
async fn resume_session_core_refuses_a_third_call_after_completion_as_not_stopped() {
    // Port of `resumeSession.test.ts`'s own "refuses a third call after completion as
    // not-stopped (the agent is now idle)" (Main gate round 4 MEDIUM): a resume that actually
    // completed leaves the Session no longer `Stopped`, so a LATER call (lock long since
    // released, a genuinely fresh attempt, not a concurrent one) must refuse `not-stopped`
    // rather than re-running the whole eligible path again.
    let id = format!("test-session-{}", uuid::Uuid::new_v4());
    let agent = fake_resumable(
        SessionStatus::Stopped,
        Some(SessionStatus::Working),
        Some("agent-exited"),
        false,
        false,
        false,
    );
    let first = resume_session_core(&agent, &id, false).await;
    assert!(first.is_ok(), "the first call must succeed");
    let third = resume_session_core(&agent, &id, false).await;
    assert!(matches!(
        third,
        Err(ResumeCoreError::Refused("not-stopped"))
    ));
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
        false,
    );
    let result = resume_session_core(&agent, &id, false).await;
    match result {
        Err(ResumeCoreError::PromptFailed(message)) => assert_eq!(message, "boom"),
        other => panic!("expected PromptFailed, got is_ok={}", other.is_ok()),
    }
    assert!(
        try_lock_resuming(&id).is_some(),
        "the busy lock must be released even on a PromptFailed exit"
    );
}

#[tokio::test]
async fn resume_session_core_swallows_a_rejected_agent_start() {
    // Port of `resumeSession.test.ts`'s own "swallows a rejected agent.start() and still returns
    // the (still-stopped) resulting snapshot": `resume_session_core`'s own `let _ =
    // agent.start().await;` discards the error structurally -- this proves it actually does,
    // not merely that every other test above happens to call a `start()` that resolves cleanly.
    let id = format!("test-session-{}", uuid::Uuid::new_v4());
    let agent = fake_resumable(
        SessionStatus::Stopped,
        None,
        Some("agent-exited"),
        false,
        false,
        true,
    );
    let result = resume_session_core(&agent, &id, false).await;
    assert!(
        result.is_ok(),
        "a rejected agent.start() must be swallowed, not propagated"
    );
    assert!(*agent.start_called.lock().unwrap());
    assert!(
        !*agent.send_called.lock().unwrap(),
        "a Session whose restart errored out stays stopped, so never send into it"
    );
}

struct FakeAttachableAgent {
    status: SessionStatus,
    terminated_unexpectedly: bool,
    start_called: StdMutex<bool>,
    notify_called: StdMutex<bool>,
    /// Gate-fix (round 5, test review MEDIUM): proves `attach_snapshot_decision` returns early
    /// (no tail read at all) for a Session that is not stopped, not merely that it refused to
    /// start.
    resolve_termination_called: StdMutex<bool>,
}

impl AttachableAgent for FakeAttachableAgent {
    async fn status(&self) -> SessionStatus {
        self.status
    }

    async fn resolve_termination(&self) -> TerminationDetectionResult {
        *self.resolve_termination_called.lock().unwrap() = true;
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
    _stop_reason: Option<&str>,
    terminated_unexpectedly: bool,
) -> FakeAttachableAgent {
    FakeAttachableAgent {
        status,
        terminated_unexpectedly,
        start_called: StdMutex::new(false),
        notify_called: StdMutex::new(false),
        resolve_termination_called: StdMutex::new(false),
    }
}

#[tokio::test]
async fn attach_snapshot_decision_is_none_and_never_starts_when_not_stopped() {
    // Port of `attachSnapshot.test.ts`'s own "never reads the tail when the agent is not
    // stopped (no detection, no start)" (Main gate round 5 MEDIUM): asserts the tail read
    // itself never happens, not merely that `start` was never called.
    let agent = fake_attachable(SessionStatus::Working, Some("agent-exited"), false);
    let detection = attach_snapshot_decision(&agent, false).await;
    assert!(detection.is_none());
    assert!(!*agent.start_called.lock().unwrap());
    assert!(
        !*agent.resolve_termination_called.lock().unwrap(),
        "a Session that is not stopped must never trigger a tail read at all"
    );
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
async fn attach_snapshot_decision_passive_open_never_starts_even_when_nothing_is_wrong() {
    // Issue #1205 (FR-103): a passive open shows saved history and never starts the agent.
    let agent = fake_attachable(SessionStatus::Stopped, Some("not-started"), false);
    let detection = attach_snapshot_decision(&agent, false).await;
    assert!(detection.is_some());
    assert!(!*agent.start_called.lock().unwrap());
    assert!(!*agent.notify_called.lock().unwrap());
}

#[tokio::test]
async fn attach_snapshot_decision_a_genuinely_crashed_session_with_the_same_stop_reason_never_auto_starts(
) {
    // Port of `attachSnapshot.test.ts`'s own "a genuinely crashed Session with the same
    // stopReason never auto-starts and the detection reaches buildSnapshot" (Main gate round 4
    // HIGH): `not-started` is normally allowed to auto-start, but a tail read proving it
    // actually died mid-turn (`terminated_unexpectedly: true`) must still block it -- and the
    // caller still gets the real detection back either way (threaded into `build_snapshot`).
    let agent = fake_attachable(SessionStatus::Stopped, Some("not-started"), true);
    let detection = attach_snapshot_decision(&agent, false).await;
    assert!(
        !*agent.start_called.lock().unwrap(),
        "a Session whose tail shows it died mid-turn must never auto-start"
    );
    assert!(
        detection.is_some_and(|d| d.terminated_unexpectedly),
        "the fresh detection result must still be returned for buildSnapshot to use"
    );
}

#[tokio::test]
async fn attach_snapshot_decision_notifies_list_changed_only_when_the_agent_actually_starts() {
    // Port of `attachSnapshot.test.ts`'s own "notifies listChanged only when the agent actually
    // starts".
    let not_stopped = fake_attachable(SessionStatus::Working, Some("agent-exited"), false);
    attach_snapshot_decision(&not_stopped, false).await;
    assert!(!*not_stopped.notify_called.lock().unwrap());

    let starts = fake_attachable(SessionStatus::Stopped, Some("not-started"), false);
    attach_snapshot_decision(&starts, true).await;
    assert!(*starts.notify_called.lock().unwrap());
}

// -------------------------------------------------------------------------------------------
// `sessions_resume`/`attach_snapshot_core` against a REAL `AppState`/registry (same `make_state`
// pattern `ipc/sessions_lifecycle_tests.rs`'s own tests use): the one TS case per handler that
// genuinely lives here -- an unknown session id -- is refused by the registry lookup BEFORE
// either handler ever creates an agent, so it needs no `ResumableAgent`/`AttachableAgent` fake at
// all.
// -------------------------------------------------------------------------------------------

fn temp_registry_dir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "refract-sessions-agent-test-registry-{label}-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).expect("create temp registry dir");
    dir
}

async fn make_state(dir: &std::path::Path) -> AppState {
    let registry = RegistryStore::open(dir).await.expect("open registry");
    let settings = SettingsStore::open(dir).await.expect("open settings");
    let registry = Arc::new(AsyncMutex::new(registry));
    let settings = Arc::new(AsyncMutex::new(settings));
    let app_handle_slot: Arc<StdMutex<Option<tauri::AppHandle>>> = Arc::new(StdMutex::new(None));
    let events = EventSink::new(app_handle_slot.clone(), registry.clone());
    let session_manager = SessionManager::new(registry.clone(), settings.clone(), events);
    AppState {
        data_dir: dir.to_path_buf(),
        registry,
        settings,
        app_handle: app_handle_slot,
        session_manager,
    }
}

#[tokio::test]
async fn sessions_resume_returns_not_found_for_an_unknown_session_id() {
    // Port of `resumeSession.test.ts`'s own "returns not-found for an unknown session id".
    let dir = temp_registry_dir("resume-not-found");
    let state = make_state(&dir).await;
    let args = vec![Value::String("missing-id".to_string())];
    let err = sessions_resume(state, args)
        .await
        .expect_err("unknown id must error");
    assert_eq!(err.code, "not-found");
}

#[tokio::test]
async fn attach_snapshot_core_returns_not_found_for_an_unknown_session_id() {
    // Port of `attachSnapshot.test.ts`'s own "returns not-found for an unknown session id".
    let dir = temp_registry_dir("attach-not-found");
    let state = make_state(&dir).await;
    let err = attach_snapshot_core(&state, "missing-id", false)
        .await
        .expect_err("unknown id must error");
    assert_eq!(err.code, "not-found");
}
