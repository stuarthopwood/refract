use super::*;

fn role(name: &str) -> Target {
    Target::Role(name.to_string())
}

fn on_role(name: &str) -> Selection<'_> {
    Selection {
        pinned: false,
        role: Some(name),
        last_model: Some(("anthropic", "haiku")),
        queued: None,
    }
}

fn pinned() -> Selection<'static> {
    Selection {
        pinned: true,
        role: None,
        last_model: Some(("anthropic", "haiku")),
        queued: None,
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
        Target::Model {
            provider: "anthropic".to_string(),
            model_id: "haiku".to_string()
        }
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
            restore: Target::Model {
                provider: "anthropic".to_string(),
                model_id: "haiku".to_string()
            }
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
fn a_role_that_names_nothing_restores_the_default_role() {
    // `temporary` is omp's ad-hoc switch marker, `fallback` a retry marker; neither is a role to go back to.
    for marker in ["temporary", "fallback", ""] {
        let swap = entered(&on_role(marker));
        assert_eq!(swap.restore, role("default"), "role {marker:?}");
    }
    let unknown = Selection {
        role: None,
        ..on_role("slow")
    };
    assert_eq!(entered(&unknown).restore, role("default"));
}

#[test]
fn a_pin_with_no_recorded_model_restores_the_default_role() {
    let swap = entered(&Selection {
        last_model: None,
        ..pinned()
    });
    assert_eq!(swap.restore, role("default"));
}

#[test]
fn a_role_the_user_queued_while_stopped_becomes_the_restore_target() {
    let queued = role("smol");
    let selection = Selection {
        queued: Some(&queued),
        ..on_role("slow")
    };
    assert_eq!(
        step(true, None, &selection, true),
        Step::Enter {
            swap: Swap {
                restore: role("smol")
            },
            apply: true
        }
    );
}

#[test]
fn plans_own_queued_switch_is_not_a_user_pick() {
    let queued = role(PLAN_ROLE);
    let selection = Selection {
        queued: Some(&queued),
        ..on_role("plan")
    };
    let swap = entered(&selection);
    assert_eq!(swap.restore, role("default"));
    assert!(matches!(
        step(false, Some(&swap), &selection, true),
        Step::Leave { .. }
    ));
}

#[test]
fn a_pick_queued_while_stopped_survives_leaving_plan() {
    let swap = entered(&on_role("slow"));
    let queued = role("smol");
    let selection = Selection {
        queued: Some(&queued),
        ..on_role("plan")
    };
    assert_eq!(step(false, Some(&swap), &selection, true), Step::Forget);
}

#[test]
fn an_interactive_launch_with_no_stint_changes_nothing() {
    assert_eq!(step(false, None, &on_role("slow"), true), Step::Keep);
}

// `on_launch` is what the plan-mode restart runs: `working_mode::restart` -> `start()` -> `launch()`
// -> `model::on_launch`. These drive its body on a real agent, with the role-map read stubbed.

use crate::session::pending_selection;
use crate::session::subagents::test_support::agent_fixture;
use crate::session::working_mode::set_launched_plan_for_test;

async fn agent_on_role(name: &str) -> std::sync::Arc<SessionAgent> {
    let fx = agent_fixture(false).await;
    fx.agent
        .with_model_state(|s| s.current_role = Some(name.to_string()))
        .await;
    fx.agent
}

async fn queued_role(agent: &SessionAgent) -> Option<String> {
    let wire = pending_selection::wire(agent).await?;
    wire["role"].as_str().map(str::to_string)
}

async fn plan_role_is_set() -> bool {
    true
}

async fn plan_role_is_unset() -> bool {
    false
}

#[tokio::test]
async fn a_plan_launch_queues_the_plan_role_and_records_the_displaced_role() {
    let agent = agent_on_role("slow").await;
    set_launched_plan_for_test(&agent, true).await;

    on_launch_with(&agent, plan_role_is_set).await;

    assert_eq!(queued_role(&agent).await.as_deref(), Some("plan"));
    let swap = agent.with_model_state(|s| s.plan_swap.clone()).await;
    assert_eq!(swap.unwrap().restore, role("slow"));
}

#[tokio::test]
async fn a_plan_launch_without_a_configured_plan_role_queues_nothing() {
    let agent = agent_on_role("slow").await;
    set_launched_plan_for_test(&agent, true).await;

    on_launch_with(&agent, plan_role_is_unset).await;

    assert_eq!(queued_role(&agent).await, None);
    assert!(agent.with_model_state(|s| s.plan_swap.is_none()).await);
}

#[tokio::test]
async fn a_restart_inside_the_plan_stint_does_not_read_the_role_map_or_queue_again() {
    let agent = agent_on_role("plan").await;
    set_launched_plan_for_test(&agent, true).await;
    agent
        .with_model_state(|s| {
            s.plan_swap = Some(Swap {
                restore: role("slow"),
            })
        })
        .await;

    on_launch_with(&agent, || async {
        panic!("a launch inside a plan stint must not read the role map")
    })
    .await;

    assert_eq!(queued_role(&agent).await, None);
    assert!(agent.with_model_state(|s| s.plan_swap.is_some()).await);
}

#[tokio::test]
async fn leaving_plan_queues_the_displaced_role_back_and_ends_the_stint() {
    let agent = agent_on_role("slow").await;
    set_launched_plan_for_test(&agent, true).await;
    on_launch_with(&agent, plan_role_is_set).await;
    // omp applied the queued switch, so the Session now sits on the Plan role.
    agent
        .with_model_state(|s| s.current_role = Some("plan".to_string()))
        .await;
    set_launched_plan_for_test(&agent, false).await;

    on_launch_with(&agent, plan_role_is_set).await;

    assert_eq!(queued_role(&agent).await.as_deref(), Some("slow"));
    assert!(agent.with_model_state(|s| s.plan_swap.is_none()).await);
}

async fn point_conversation_at(agent: &SessionAgent, role_in_file: &str) {
    let dir = crate::test_scratch::path(format!("plan-role-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let file = dir.join("conversation.jsonl");
    let entry =
        format!(r#"{{"type":"model_change","id":"a1","model":"p/m","role":"{role_in_file}"}}"#);
    tokio::fs::write(&file, format!("{entry}\n")).await.unwrap();
    let patch = crate::store::registry::SessionPatch {
        current_conversation: Some(Some(file.to_string_lossy().into_owned())),
        ..Default::default()
    };
    agent
        .registry()
        .lock()
        .await
        .update_session(agent.session_id(), patch)
        .await
        .unwrap();
}

/// omp writes `role: "temporary"` for a `/switch @plan`, and the plan-mode restart re-reads that file.
#[tokio::test]
async fn leaving_plan_restores_the_role_after_the_restart_re_reads_an_ad_hoc_switch() {
    let agent = agent_on_role("slow").await;
    set_launched_plan_for_test(&agent, true).await;
    on_launch_with(&agent, plan_role_is_set).await;
    agent
        .with_model_state(|s| s.current_role = Some("plan".to_string()))
        .await;
    point_conversation_at(&agent, "temporary").await;
    set_launched_plan_for_test(&agent, false).await;

    model_support::seed_role_at_launch(&agent).await;
    on_launch_with(&agent, plan_role_is_set).await;

    assert_eq!(queued_role(&agent).await.as_deref(), Some("slow"));
    assert!(agent.with_model_state(|s| s.plan_swap.is_none()).await);
}

/// The app restarts with the mode persisted as Plan: the file says `temporary`, nothing is carried
/// in memory, so the role before plan mode is lost. Leaving plan must still land on `default`.
#[tokio::test]
async fn an_app_restart_in_plan_mode_leaves_to_the_default_role() {
    let fx = agent_fixture(false).await;
    let agent = fx.agent;
    point_conversation_at(&agent, "temporary").await;
    set_launched_plan_for_test(&agent, true).await;
    model_support::seed_role_at_launch(&agent).await;
    assert_eq!(
        agent
            .with_model_state(|s| s.current_role.clone())
            .await
            .as_deref(),
        Some("temporary")
    );

    on_launch_with(&agent, plan_role_is_set).await;
    assert_eq!(queued_role(&agent).await.as_deref(), Some("plan"));
    // omp applied the switch (the file still reads `temporary`) and the user then leaves plan mode.
    agent
        .with_model_state(|s| s.current_role = Some("plan".to_string()))
        .await;
    set_launched_plan_for_test(&agent, false).await;
    model_support::seed_role_at_launch(&agent).await;
    on_launch_with(&agent, plan_role_is_set).await;

    assert_eq!(queued_role(&agent).await.as_deref(), Some("default"));
    assert!(agent.with_model_state(|s| s.plan_swap.is_none()).await);
}

#[tokio::test]
async fn a_role_queued_while_stopped_is_restored_not_overwritten_by_the_plan_launch() {
    let agent = agent_on_role("slow").await;
    pending_selection::queue(&agent, role("smol")).await;
    set_launched_plan_for_test(&agent, true).await;

    on_launch_with(&agent, plan_role_is_set).await;
    assert_eq!(queued_role(&agent).await.as_deref(), Some("plan"));
    agent
        .with_model_state(|s| s.current_role = Some("plan".to_string()))
        .await;
    set_launched_plan_for_test(&agent, false).await;
    on_launch_with(&agent, plan_role_is_set).await;

    assert_eq!(queued_role(&agent).await.as_deref(), Some("smol"));
}
