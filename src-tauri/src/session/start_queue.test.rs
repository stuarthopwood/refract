// Unit tests for `session::start_queue` (lane R3, issue #786): the typed start-stage transition
// table (issues #706/#709's own "illegal transitions unrepresentable" requirement), the wire
// serialisation of each stage, and the spawned-count RAII guard. `#[path]`-loaded sibling of
// `start_queue.rs` (excluded from `check:file-size` by its own `.test.rs` name).
use super::*;

#[test]
fn legal_transitions_from_the_start() {
    assert!(validate_transition(None, StartStage::Queued).is_ok());
    assert!(validate_transition(None, StartStage::Waiting).is_ok());
}

#[test]
fn illegal_to_jump_straight_to_a_later_stage_from_nothing() {
    assert!(validate_transition(None, StartStage::Prompt).is_err());
    assert!(validate_transition(None, StartStage::Extended).is_err());
}

#[test]
fn legal_starting_points_include_memory_deferred_and_cancelled() {
    // A start can begin already under memory pressure with its slot granted immediately (no
    // `Queued` stage at all), and a cancel can land in that same narrow window before any stage
    // was ever set.
    assert!(validate_transition(None, StartStage::MemoryDeferred).is_ok());
    assert!(validate_transition(None, StartStage::Cancelled).is_ok());
}

#[test]
fn legal_forward_chain_queued_to_memory_deferred_to_waiting_to_prompt_to_extended() {
    assert!(validate_transition(Some(StartStage::Queued), StartStage::MemoryDeferred).is_ok());
    assert!(validate_transition(Some(StartStage::MemoryDeferred), StartStage::Waiting).is_ok());
    assert!(validate_transition(Some(StartStage::Waiting), StartStage::Prompt).is_ok());
    assert!(validate_transition(Some(StartStage::Prompt), StartStage::Extended).is_ok());
}

#[test]
fn a_stage_may_legally_repeat_itself_for_the_ready_wait_ticker() {
    assert!(validate_transition(Some(StartStage::Waiting), StartStage::Waiting).is_ok());
    assert!(validate_transition(Some(StartStage::Prompt), StartStage::Prompt).is_ok());
    assert!(validate_transition(Some(StartStage::Extended), StartStage::Extended).is_ok());
}

#[test]
fn illegal_to_skip_backwards_from_extended_to_prompt() {
    // "Keep waiting" dismisses the prompt permanently; the ready-wait ticker must never revert
    // an already-extended Session back to a dismissable prompt.
    assert!(validate_transition(Some(StartStage::Extended), StartStage::Prompt).is_err());
}

#[test]
fn illegal_to_skip_backwards_from_prompt_to_waiting() {
    assert!(validate_transition(Some(StartStage::Prompt), StartStage::Waiting).is_err());
}

#[test]
fn illegal_to_re_enter_memory_deferred_after_waiting_has_begun() {
    assert!(validate_transition(Some(StartStage::Waiting), StartStage::MemoryDeferred).is_err());
}

#[test]
fn cancel_is_reachable_from_every_non_terminal_stage() {
    assert!(validate_transition(Some(StartStage::Queued), StartStage::Cancelled).is_ok());
    assert!(validate_transition(Some(StartStage::MemoryDeferred), StartStage::Cancelled).is_ok());
    assert!(validate_transition(Some(StartStage::Waiting), StartStage::Cancelled).is_ok());
    assert!(validate_transition(Some(StartStage::Prompt), StartStage::Cancelled).is_ok());
    assert!(validate_transition(Some(StartStage::Extended), StartStage::Cancelled).is_ok());
}

#[test]
fn cancelled_is_terminal_nothing_transitions_out_of_it() {
    for next in [
        StartStage::Queued,
        StartStage::MemoryDeferred,
        StartStage::Waiting,
        StartStage::Prompt,
        StartStage::Extended,
        StartStage::Cancelled,
    ] {
        assert!(
            validate_transition(Some(StartStage::Cancelled), next).is_err(),
            "Cancelled -> {next:?} must be illegal"
        );
    }
}

#[test]
fn to_wire_is_none_while_nothing_is_in_flight() {
    let state = State::default();
    assert_eq!(state.to_wire(), None);
}

#[test]
fn to_wire_never_puts_cancelled_on_the_wire() {
    // Security/correctness gate-fix: `SessionStartProgress` (`src/shared/model.ts`) has no
    // `'cancelled'` variant at all -- a cancelled start must read exactly like "nothing in
    // flight" to the wire, the same `None` as a Session that was never starting.
    let state = State {
        stage: Some(StartStage::Cancelled),
        elapsed_ms: 42,
        cancel: None,
        ready_wait_active: false,
        cancel_already_recorded: false,
    };
    assert_eq!(state.to_wire(), None);
}

#[test]
fn to_wire_matches_the_shared_sessionstartprogress_shape() {
    let mut state = State {
        stage: Some(StartStage::Queued),
        ..Default::default()
    };
    assert_eq!(
        state.to_wire(),
        Some(serde_json::json!({ "kind": "queued" }))
    );

    state.stage = Some(StartStage::MemoryDeferred);
    state.elapsed_ms = 2_500;
    assert_eq!(
        state.to_wire(),
        Some(serde_json::json!({ "kind": "memory-deferred", "elapsedMs": 2_500 }))
    );

    for (stage, kind) in [
        (StartStage::Waiting, "waiting"),
        (StartStage::Prompt, "prompt"),
        (StartStage::Extended, "extended"),
    ] {
        state.stage = Some(stage);
        state.elapsed_ms = 61_000;
        assert_eq!(
            state.to_wire(),
            Some(serde_json::json!({ "kind": kind, "elapsedMs": 61_000 }))
        );
    }
}

/// `cargo test` runs tests in parallel threads by default; `SPAWNED_COUNT` is a single
/// process-wide static, so the two tests below must never interleave their own increments with
/// each other (any other test in this crate never touches it).
static SPAWNED_COUNT_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn spawned_guard_increments_and_decrements_on_drop() {
    let _lock = SPAWNED_COUNT_TEST_LOCK.lock().unwrap();
    let before = spawned_in_flight();
    {
        let _guard = mark_spawned();
        assert_eq!(spawned_in_flight(), before + 1);
    }
    assert_eq!(spawned_in_flight(), before);
}

#[test]
fn spawned_guard_count_is_independent_per_guard() {
    let _lock = SPAWNED_COUNT_TEST_LOCK.lock().unwrap();
    let before = spawned_in_flight();
    let guard_a = mark_spawned();
    let guard_b = mark_spawned();
    assert_eq!(spawned_in_flight(), before + 2);
    drop(guard_a);
    assert_eq!(spawned_in_flight(), before + 1);
    drop(guard_b);
    assert_eq!(spawned_in_flight(), before);
}
