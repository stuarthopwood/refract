// The `/new` guard: a never-started Session is a no-op, anything else keeps its old behaviour.

use super::{new_conversation_is_noop, SessionStatus};

#[test]
fn a_never_started_session_makes_new_a_no_op() {
    assert!(new_conversation_is_noop(
        SessionStatus::Stopped,
        false,
        Some("not-started")
    ));
    assert!(new_conversation_is_noop(
        SessionStatus::Stopped,
        false,
        None
    ));
}

#[test]
fn a_running_session_keeps_the_existing_new_behaviour() {
    assert!(!new_conversation_is_noop(SessionStatus::Idle, true, None));
    assert!(!new_conversation_is_noop(
        SessionStatus::Working,
        true,
        None
    ));
}

#[test]
fn a_stopped_session_that_once_ran_is_not_a_no_op() {
    assert!(!new_conversation_is_noop(
        SessionStatus::Stopped,
        false,
        Some("crashed")
    ));
    assert!(!new_conversation_is_noop(
        SessionStatus::Stopped,
        true,
        Some("not-started")
    ));
}
