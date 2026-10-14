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

#[test]
fn validate_transition_matches_the_full_expected_legal_set_exhaustively() {
    // Issue #706/#709's own acceptance criterion: "every illegal start transition is rejected".
    // Gate-fix (test review HIGH, round 6): the hand-picked tests above only ever asserted 11 of
    // this table's illegal pairs one at a time; this checks ALL 42 `(current, next)` pairs this
    // type can represent against one literal, independently-written expected-legal table (not
    // derived from `validate_transition` itself, so a change to one without the other fails
    // here). Note: this table has 23 illegal pairs, not 22 -- `Waiting -> Extended` is illegal
    // too (`Waiting`'s own legal set is `{Waiting, Prompt, Cancelled}`) and was missing from
    // every hand-picked test above as well as this fix's own illegal-pair count; this exhaustive
    // form catches it regardless.
    use StartStage::{Cancelled, Extended, MemoryDeferred, Prompt, Queued, Waiting};
    let all_stages = [Queued, MemoryDeferred, Waiting, Prompt, Extended, Cancelled];
    let expected_legal = |current: Option<StartStage>, next: StartStage| -> bool {
        match current {
            None => matches!(next, Queued | MemoryDeferred | Waiting | Cancelled),
            Some(Queued) => matches!(next, Queued | MemoryDeferred | Waiting | Cancelled),
            Some(MemoryDeferred) => matches!(next, MemoryDeferred | Waiting | Cancelled),
            Some(Waiting) => matches!(next, Waiting | Prompt | Cancelled),
            Some(Prompt) => matches!(next, Prompt | Extended | Cancelled),
            Some(Extended) => matches!(next, Extended | Cancelled),
            Some(Cancelled) => false,
        }
    };
    let mut currents: Vec<Option<StartStage>> = vec![None];
    currents.extend(all_stages.iter().copied().map(Some));
    let mut illegal_count = 0;
    for current in currents {
        for next in all_stages {
            let expected = expected_legal(current, next);
            if !expected {
                illegal_count += 1;
            }
            assert_eq!(
                validate_transition(current, next).is_ok(),
                expected,
                "{current:?} -> {next:?}: expected legal={expected}"
            );
        }
    }
    assert_eq!(
        illegal_count, 23,
        "expected-legal table itself should have exactly 23 illegal pairs"
    );
}

async fn make_test_agent(label: &str) -> std::sync::Arc<SessionAgent> {
    let dir = std::env::temp_dir().join(format!(
        "refract-start-queue-test-{label}-{}",
        uuid::Uuid::new_v4()
    ));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let registry = std::sync::Arc::new(tokio::sync::Mutex::new(
        crate::store::registry::RegistryStore::open(&dir)
            .await
            .unwrap(),
    ));
    let settings = std::sync::Arc::new(tokio::sync::Mutex::new(
        crate::store::settings::SettingsStore::open(&dir)
            .await
            .unwrap(),
    ));
    let app_handle_slot = std::sync::Arc::new(std::sync::Mutex::new(None));
    let events = crate::events::EventSink::new(app_handle_slot, registry.clone());
    let manager = crate::session::manager::SessionManager::new(registry, settings, events);
    manager.get_or_create_agent(&format!("session-{label}"))
}

#[tokio::test]
async fn take_cancel_already_recorded_reads_and_resets_exactly_once() {
    // Round-5 fix's own flag (`cancel_already_recorded`): `agent::launch`'s own `wait_ready`
    // error branch calls this exactly once per attempt to tell "a cancel already recorded a
    // clean status for this exact exit" apart from a genuine ready-wait failure. Never tested
    // directly before (test review MEDIUM, round 6).
    let agent = make_test_agent("take-cancel-recorded").await;
    assert!(
        !take_cancel_already_recorded(&agent).await,
        "a fresh agent has nothing recorded"
    );
    agent
        .with_start_queue_state(|s| s.cancel_already_recorded = true)
        .await;
    assert!(
        take_cancel_already_recorded(&agent).await,
        "set flag must read back true"
    );
    assert!(
        !take_cancel_already_recorded(&agent).await,
        "the read above must have reset it -- a second call never suppresses a LATER, \
         unrelated failure report"
    );
}
