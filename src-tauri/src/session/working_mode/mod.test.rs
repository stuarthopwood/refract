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
