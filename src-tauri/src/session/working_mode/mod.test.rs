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
