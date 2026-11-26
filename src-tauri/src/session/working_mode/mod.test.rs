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
