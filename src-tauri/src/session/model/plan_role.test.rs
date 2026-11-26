use super::*;

fn role(name: &str) -> Option<Target> {
    Some(Target::Role(name.to_string()))
}

fn on_role(name: &str) -> Selection<'_> {
    Selection {
        pinned: false,
        role: Some(name),
        last_model: Some(("anthropic", "haiku")),
    }
}

fn pinned() -> Selection<'static> {
    Selection {
        pinned: true,
        role: None,
        last_model: Some(("anthropic", "haiku")),
    }
}

fn entered(selection: &Selection<'_>) -> Swap {
    match step(true, None, selection, true) {
        Step::Enter { swap, .. } => swap,
        other => panic!("expected Enter, got {other:?}"),
    }
}

#[test]
fn entering_plan_queues_the_plan_role_and_remembers_the_role() {
    let step = step(true, None, &on_role("slow"), true);
    assert_eq!(
        step,
        Step::Enter {
            swap: Swap {
                restore: role("slow")
            },
            apply: true
        }
    );
}

#[test]
fn entering_plan_over_a_pinned_model_remembers_the_pin() {
    let swap = entered(&pinned());
    assert_eq!(
        swap.restore,
        Some(Target::Model {
            provider: "anthropic".to_string(),
            model_id: "haiku".to_string()
        })
    );
}

#[test]
fn a_session_already_on_the_plan_role_is_not_switched_again() {
    let step = step(true, None, &on_role("plan"), true);
    assert_eq!(
        step,
        Step::Enter {
            swap: Swap {
                restore: role("default")
            },
            apply: false
        }
    );
}

#[test]
fn an_unset_plan_role_leaves_the_session_alone() {
    assert_eq!(step(true, None, &on_role("slow"), false), Step::Keep);
}

#[test]
fn a_restart_inside_the_plan_stint_changes_nothing() {
    let swap = entered(&on_role("slow"));
    assert_eq!(step(true, Some(&swap), &on_role("plan"), true), Step::Keep);
}

#[test]
fn leaving_plan_restores_the_role_the_session_was_on() {
    let swap = entered(&on_role("slow"));
    assert_eq!(
        step(false, Some(&swap), &on_role("plan"), true),
        Step::Leave {
            restore: role("slow")
        }
    );
}

#[test]
fn leaving_plan_restores_a_pinned_model() {
    let swap = entered(&pinned());
    let step = step(false, Some(&swap), &on_role("plan"), true);
    assert_eq!(
        step,
        Step::Leave {
            restore: Some(Target::Model {
                provider: "anthropic".to_string(),
                model_id: "haiku".to_string()
            })
        }
    );
}

#[test]
fn a_choice_made_during_plan_mode_survives_leaving_it() {
    let swap = entered(&on_role("slow"));
    assert_eq!(
        step(false, Some(&swap), &on_role("smol"), true),
        Step::Forget
    );
    assert_eq!(step(false, Some(&swap), &pinned(), true), Step::Forget);
}

#[test]
fn an_interactive_launch_with_no_stint_changes_nothing() {
    assert_eq!(step(false, None, &on_role("slow"), true), Step::Keep);
}
