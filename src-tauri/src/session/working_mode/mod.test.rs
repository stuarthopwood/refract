use super::*;

#[test]
fn plan_mode_adds_a_plan_only_instruction() {
    let text = instruction_for(WorkingMode::Plan).unwrap();
    assert!(text.contains("Plan only"));
    assert!(text.contains("Write the plan in your reply"));
}

#[test]
fn only_interactive_adds_no_instruction() {
    assert!(instruction_for(WorkingMode::Interactive).is_none());
    assert!(instruction_for(WorkingMode::Grill).is_some());
    assert!(instruction_for(WorkingMode::Away).is_some());
}

fn state(mode: WorkingMode, launched_plan: bool) -> State {
    State {
        loaded: true,
        mode,
        launched_plan,
        ..Default::default()
    }
}

#[test]
fn a_plan_switch_on_an_idle_session_with_a_process_restarts_it() {
    let mut s = state(WorkingMode::Interactive, false);
    let (previous, applied) = decide(&mut s, WorkingMode::Plan, SessionStatus::Idle, true);
    assert_eq!(previous, WorkingMode::Interactive);
    assert!(matches!(applied, Applied::Restart));
    assert_eq!(s.mode, WorkingMode::Plan);
}

#[test]
fn a_plan_switch_mid_turn_waits_for_the_settle() {
    let mut s = state(WorkingMode::Interactive, false);
    let (_, applied) = decide(&mut s, WorkingMode::Plan, SessionStatus::Working, true);
    assert!(matches!(applied, Applied::Pending));
    assert_eq!(s.mode, WorkingMode::Interactive);
    assert_eq!(s.pending, Some(WorkingMode::Plan));
}

#[test]
fn a_plan_switch_during_start_is_recorded_and_the_new_process_is_found_stale() {
    // No process is recorded yet, but the launch already read the mode as not-plan.
    let mut s = state(WorkingMode::Interactive, false);
    let (_, applied) = decide(&mut s, WorkingMode::Plan, SessionStatus::Stopped, false);
    assert!(matches!(applied, Applied::Switched));
    assert_eq!(s.mode, WorkingMode::Plan);
    assert!(
        launch_is_stale(&s),
        "on_launched must relaunch this process"
    );
}

#[test]
fn a_launch_that_read_the_current_mode_is_not_stale() {
    assert!(!launch_is_stale(&state(WorkingMode::Plan, true)));
    assert!(!launch_is_stale(&state(WorkingMode::Interactive, false)));
    assert!(!launch_is_stale(&state(WorkingMode::Grill, false)));
    // Leaving plan during start is stale the other way: the process holds the deny policy.
    assert!(launch_is_stale(&state(WorkingMode::Interactive, true)));
}

#[test]
fn only_one_restart_can_be_in_flight() {
    let mut s = state(WorkingMode::Plan, false);
    assert!(claim_restart(&mut s), "the first request takes the slot");
    assert!(!claim_restart(&mut s), "a second one is dropped");
    s.restarting = false;
    assert!(
        claim_restart(&mut s),
        "the slot is free again once released"
    );
}

/// The drop releases on the runtime, so a test waits for it rather than asserting at once.
async fn restart_slot_frees_soon(agent: &Arc<SessionAgent>) -> bool {
    for _ in 0..100 {
        if RestartSlot::claim(agent).await.is_some() {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    false
}

#[tokio::test]
async fn an_aborted_restart_frees_the_slot() {
    let fx = crate::session::subagents::test_support::agent_fixture(false).await;
    let agent = fx.agent.arc();
    let held = RestartSlot::claim(&agent).await.expect("the slot is free");
    let task = tokio::spawn(async move {
        let _held = held;
        std::future::pending::<()>().await;
    });
    task.abort();
    assert!(task.await.is_err());

    assert!(restart_slot_frees_soon(&agent).await);
}

#[tokio::test]
async fn a_panicking_restart_frees_the_slot() {
    let fx = crate::session::subagents::test_support::agent_fixture(false).await;
    let agent = fx.agent.arc();
    let held = RestartSlot::claim(&agent).await.expect("the slot is free");
    let task = tokio::spawn(async move {
        let _held = held;
        panic!("a restart that panics");
    });
    assert!(task.await.is_err());

    assert!(restart_slot_frees_soon(&agent).await);
}

#[tokio::test]
async fn a_released_slot_can_be_claimed_again_and_a_held_one_cannot() {
    let fx = crate::session::subagents::test_support::agent_fixture(false).await;
    let agent = fx.agent.arc();
    let first = RestartSlot::claim(&agent).await.expect("the slot is free");
    assert!(RestartSlot::claim(&agent).await.is_none());
    first.release().await;
    assert!(RestartSlot::claim(&agent).await.is_some());
}

#[tokio::test]
async fn a_stale_launch_asks_for_one_restart() {
    let fx = crate::session::subagents::test_support::agent_fixture(false).await;
    set_launched_plan_for_test(&fx.agent, false).await;
    fx.agent
        .with_working_mode_state(|s| s.mode = WorkingMode::Plan)
        .await;
    let calls = std::cell::Cell::new(0);

    let stale = relaunch_if_stale(&fx.agent, |_| calls.set(calls.get() + 1)).await;

    assert!(stale);
    assert_eq!(calls.get(), 1);
}

#[tokio::test]
async fn a_launch_that_matches_the_mode_asks_for_no_restart() {
    let fx = crate::session::subagents::test_support::agent_fixture(false).await;
    set_launched_plan_for_test(&fx.agent, true).await;
    let calls = std::cell::Cell::new(0);

    let stale = relaunch_if_stale(&fx.agent, |_| calls.set(calls.get() + 1)).await;

    assert!(!stale);
    assert_eq!(calls.get(), 0);
}

#[test]
fn re_picking_the_current_mode_changes_nothing_and_clears_a_waiting_switch() {
    let mut s = state(WorkingMode::Interactive, false);
    s.pending = Some(WorkingMode::Plan);
    let (previous, applied) = decide(
        &mut s,
        WorkingMode::Interactive,
        SessionStatus::Working,
        true,
    );
    assert_eq!(previous, WorkingMode::Interactive);
    assert!(matches!(applied, Applied::Same));
    assert_eq!(s.pending, None);
    assert_eq!(s.mode, WorkingMode::Interactive);
}

#[test]
fn leaving_plan_for_interactive_on_an_idle_session_with_a_process_restarts() {
    let mut s = state(WorkingMode::Plan, true);
    let (previous, applied) = decide(&mut s, WorkingMode::Interactive, SessionStatus::Idle, true);
    assert_eq!(previous, WorkingMode::Plan);
    assert!(matches!(applied, Applied::Restart));
    assert_eq!(s.mode, WorkingMode::Interactive);
}

#[test]
fn going_from_away_to_plan_on_an_idle_session_with_a_process_restarts() {
    let mut s = state(WorkingMode::Away, false);
    let (previous, applied) = decide(&mut s, WorkingMode::Plan, SessionStatus::Idle, true);
    assert_eq!(previous, WorkingMode::Away);
    assert!(matches!(applied, Applied::Restart));
    assert_eq!(s.mode, WorkingMode::Plan);
}

#[test]
fn a_plan_switch_while_the_session_needs_you_waits() {
    let mut s = state(WorkingMode::Interactive, false);
    let (_, applied) = decide(&mut s, WorkingMode::Plan, SessionStatus::NeedsYou, true);
    assert!(matches!(applied, Applied::Pending));
    assert_eq!(s.pending, Some(WorkingMode::Plan));
    assert_eq!(
        s.mode,
        WorkingMode::Interactive,
        "the mode holds until the turn settles"
    );
}

#[test]
fn a_waiting_plan_switch_that_changes_the_launch_mode_needs_a_restart_when_it_settles() {
    let mut s = state(WorkingMode::Interactive, false);
    s.pending = Some(WorkingMode::Plan);
    assert_eq!(settle_pending(&mut s), Some((WorkingMode::Plan, true)));
    assert_eq!(s.mode, WorkingMode::Plan);
    assert_eq!(s.pending, None);
}

#[test]
fn a_waiting_switch_that_keeps_the_launch_mode_needs_no_restart_and_nothing_waiting_is_none() {
    let mut s = state(WorkingMode::Plan, true);
    s.pending = Some(WorkingMode::Plan);
    assert_eq!(settle_pending(&mut s), Some((WorkingMode::Plan, false)));
    assert_eq!(settle_pending(&mut s), None);
}

fn applied_name(applied: &Applied) -> &'static str {
    match applied {
        Applied::Same => "same",
        Applied::Switched => "switched",
        Applied::Pending => "pending",
        Applied::Restart => "restart",
    }
}

use WorkingMode::{Away, Grill, Interactive, Plan};

type Case = (WorkingMode, bool, WorkingMode, SessionStatus, bool);
type Expected = (&'static str, WorkingMode, Option<WorkingMode>);

#[test]
fn every_mode_transition_lands_on_the_outcome_a_user_sees() {
    use SessionStatus::{Idle, NeedsYou, Stopped, Working};
    // (from, launched in plan, to, status, has process) -> (outcome, mode now, waiting switch)
    let table: [(Case, Expected); 22] = [
        // Modes that need no OMP restart switch at once, busy or not.
        (
            (Interactive, false, Grill, Working, true),
            ("switched", Grill, None),
        ),
        (
            (Grill, false, Away, NeedsYou, true),
            ("switched", Away, None),
        ),
        (
            (Interactive, false, Away, Idle, true),
            ("switched", Away, None),
        ),
        (
            (Grill, false, Interactive, Working, true),
            ("switched", Interactive, None),
        ),
        // Plan changes the launch mode, so it restarts a live process when idle or stopped.
        (
            (Interactive, false, Plan, Idle, true),
            ("restart", Plan, None),
        ),
        ((Grill, false, Plan, Stopped, true), ("restart", Plan, None)),
        ((Away, false, Plan, Idle, true), ("restart", Plan, None)),
        (
            (Plan, true, Interactive, Idle, true),
            ("restart", Interactive, None),
        ),
        ((Plan, true, Away, Idle, true), ("restart", Away, None)),
        ((Plan, true, Grill, Stopped, true), ("restart", Grill, None)),
        // Mid-turn the switch waits and the mode holds.
        (
            (Interactive, false, Plan, Working, true),
            ("pending", Interactive, Some(Plan)),
        ),
        (
            (Grill, false, Plan, NeedsYou, true),
            ("pending", Grill, Some(Plan)),
        ),
        (
            (Plan, true, Interactive, Working, true),
            ("pending", Plan, Some(Interactive)),
        ),
        (
            (Plan, true, Away, NeedsYou, true),
            ("pending", Plan, Some(Away)),
        ),
        // Leaving Away is immediate even when the plan switch waits.
        (
            (Away, false, Plan, Working, true),
            ("pending", Interactive, Some(Plan)),
        ),
        (
            (Away, false, Plan, NeedsYou, true),
            ("pending", Interactive, Some(Plan)),
        ),
        // No process yet: nothing to restart, whatever the status.
        (
            (Interactive, false, Plan, Working, false),
            ("switched", Plan, None),
        ),
        (
            (Plan, true, Interactive, Idle, false),
            ("switched", Interactive, None),
        ),
        // A process already launched in the target's plan-ness needs no restart.
        (
            (Interactive, true, Plan, Working, true),
            ("switched", Plan, None),
        ),
        (
            (Plan, false, Grill, Working, true),
            ("switched", Grill, None),
        ),
        // Re-picking the current mode is never a change.
        ((Away, false, Away, Working, true), ("same", Away, None)),
        ((Plan, true, Plan, Idle, true), ("same", Plan, None)),
    ];
    for ((from, launched, to, status, has_process), (outcome, mode, waiting)) in table {
        let mut s = state(from, launched);
        let (previous, applied) = decide(&mut s, to, status, has_process);
        let case = format!(
            "{from:?} (plan launch {launched}) -> {to:?} while {status:?}, process {has_process}"
        );
        assert_eq!(previous, from, "{case}");
        assert_eq!(applied_name(&applied), outcome, "{case}");
        assert_eq!(s.mode, mode, "{case}");
        assert_eq!(s.pending, waiting, "{case}");
    }
}

#[test]
fn a_new_pick_replaces_a_waiting_switch() {
    let mut s = state(Interactive, false);
    decide(&mut s, Plan, SessionStatus::Working, true);
    assert_eq!(s.pending, Some(Plan));

    let (_, applied) = decide(&mut s, Grill, SessionStatus::Working, true);

    assert_eq!(applied_name(&applied), "switched");
    assert_eq!(s.mode, Grill);
    assert_eq!(
        s.pending, None,
        "the earlier Plan request no longer applies"
    );
}

#[test]
fn the_wire_state_carries_the_mode_and_only_a_waiting_switch() {
    let mut s = state(Interactive, false);
    let mut wire = Map::new();
    s.insert_wire(&mut wire);
    assert_eq!(wire["workingMode"], json!("interactive"));
    assert!(!wire.contains_key("workingModePending"));

    s.pending = Some(Plan);
    s.insert_wire(&mut wire);
    assert_eq!(wire["workingModePending"], json!("plan"));
}

#[test]
fn only_the_four_known_modes_parse() {
    for (raw, mode) in [
        ("interactive", Interactive),
        ("plan", Plan),
        ("grill", Grill),
        ("away", Away),
    ] {
        assert_eq!(WorkingMode::parse(raw), Some(mode), "{raw}");
    }
    for raw in ["", "Plan", "AWAY", "yolo", " plan"] {
        assert_eq!(WorkingMode::parse(raw), None, "{raw:?}");
    }
}

#[test]
fn away_is_the_only_mode_that_does_not_survive_a_restart() {
    assert_eq!(Away.persistable(), Interactive);
    for mode in [Interactive, Plan, Grill] {
        assert_eq!(mode.persistable(), mode);
    }
}

#[tokio::test]
async fn an_unknown_mode_is_refused_and_the_current_mode_is_untouched() {
    let fx = crate::session::subagents::test_support::agent_fixture(false).await;
    fx.agent
        .with_working_mode_state(|s| {
            s.loaded = true;
            s.mode = Grill;
        })
        .await;

    let err = set_mode(&fx.agent, "turbo").await.unwrap_err();

    assert_eq!(err.code, "invalid-argument");
    assert!(err.message.contains("turbo"), "{}", err.message);
    assert_eq!(fx.agent.with_working_mode_state(|s| s.mode).await, Grill);
}
