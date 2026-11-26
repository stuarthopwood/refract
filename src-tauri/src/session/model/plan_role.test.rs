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

/// omp writes `role: "temporary"` for a `/switch @plan`, and the plan-mode restart re-reads that file.
#[tokio::test]
async fn leaving_plan_restores_the_role_after_the_restart_re_reads_an_ad_hoc_switch() {
    let agent = agent_on_role("slow").await;
    set_launched_plan_for_test(&agent, true).await;
    on_launch_with(&agent, plan_role_is_set).await;
    agent
        .with_model_state(|s| s.current_role = Some("plan".to_string()))
        .await;
    let dir = crate::test_scratch::path(format!("plan-role-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let file = dir.join("conversation.jsonl");
    let entry = r#"{"type":"model_change","id":"a1","model":"p/m","role":"temporary"}"#;
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
    set_launched_plan_for_test(&agent, false).await;

    model_support::seed_role_at_launch(&agent).await;
    on_launch_with(&agent, plan_role_is_set).await;

    assert_eq!(queued_role(&agent).await.as_deref(), Some("slow"));
    assert!(agent.with_model_state(|s| s.plan_swap.is_none()).await);
}
