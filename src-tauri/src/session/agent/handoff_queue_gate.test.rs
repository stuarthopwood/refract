// A settled cross-Session handoff holds the Project's tree gate from its check to its action (#1861).

use std::future::Future;
use std::time::Duration;

use super::{try_queue, HandoffAction};
use crate::agent_tools::tree_gate;
use crate::session::agent::pause_subagents::fixture::{fixture_with, Fixture, Stub};
use crate::session::agent::SessionStatus;
use crate::store::registry::SessionPatch;

/// The new Conversation's RPC waits for `release`, so the action stays in flight while a test looks.
async fn gated_fixture() -> Fixture {
    fixture_with(Stub {
        gated: Some("new_session"),
        ..Stub::default()
    })
    .await
}

async fn reparent(fx: &Fixture, id: &str, parent: Option<&str>) {
    let registry = fx.agent.registry().clone();
    let patch = SessionPatch {
        parent_session_id: Some(parent.map(str::to_string)),
        ..Default::default()
    };
    registry
        .lock()
        .await
        .update_session(id, patch)
        .await
        .unwrap();
}

/// `sender` owns the agent under test, and a `New` action queued in a turn that has now settled.
async fn queue_settled(fx: &Fixture, sender: Option<(String, String)>) {
    fx.add_session("sender", &[], false).await;
    reparent(fx, &fx.agent.session_id, Some("sender")).await;
    let mut state = fx.agent.state.lock().await;
    state.status = SessionStatus::Working;
    state.turn_generation = 1;
    let action = HandoffAction::New {
        prompt: "later".into(),
    };
    try_queue(&mut state, action, sender, false).unwrap();
    state.turn_generation = 2;
    state.status = SessionStatus::Idle;
}

fn planner() -> Option<(String, String)> {
    Some(("Planner".into(), "sender".into()))
}

fn settle_in_background(fx: &Fixture) -> tokio::task::JoinHandle<()> {
    let agent = fx.agent.clone();
    tokio::spawn(async move { agent.run_settled_handoff(2).await })
}

async fn gate_is_held(repo: &str) -> bool {
    tokio::time::timeout(Duration::from_millis(50), tree_gate::lock(repo))
        .await
        .is_err()
}

async fn finished(task: tokio::task::JoinHandle<()>) {
    tokio::time::timeout(Duration::from_secs(60), task)
        .await
        .expect("the settled handoff hung")
        .unwrap();
}

#[tokio::test]
async fn the_tree_gate_is_held_while_a_cross_session_action_runs_and_freed_after() {
    let fx = gated_fixture().await;
    queue_settled(&fx, planner()).await;

    let task = settle_in_background(&fx);
    fx.until_rpc("new_session").await;
    let during = gate_is_held(&fx.repo).await;
    fx.release().await;
    finished(task).await;

    assert!(during, "the gate must be held while the action runs");
    assert!(
        !gate_is_held(&fx.repo).await,
        "the gate must be released on return"
    );
    fx.finish().await;
}

#[tokio::test]
async fn a_self_handoff_takes_no_tree_gate() {
    let fx = gated_fixture().await;
    queue_settled(&fx, None).await;

    let task = settle_in_background(&fx);
    fx.until_rpc("new_session").await;
    let during = gate_is_held(&fx.repo).await;
    fx.release().await;
    finished(task).await;

    assert!(!during, "a self-handoff changes no tree link");
    fx.finish().await;
}

#[tokio::test]
async fn a_reparent_that_wins_the_gate_first_drops_the_uncarded_action() {
    let fx = gated_fixture().await;
    queue_settled(&fx, planner()).await;
    let reparenting = tree_gate::lock(&fx.repo).await;

    let task = settle_in_background(&fx);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !fx.rpc_types().await.iter().any(|t| t == "new_session"),
        "the action must wait for the gate"
    );
    // What `sessions_update` does under the gate: the target leaves the sender's tree.
    reparent(&fx, &fx.agent.session_id, None).await;
    drop(reparenting);
    finished(task).await;

    assert!(!fx.rpc_types().await.iter().any(|t| t == "new_session"));
    assert_eq!(
        fx.notices().await,
        ["Handoff dropped: the Session moved out of the sending Session's tree after the action was queued"]
    );
    fx.finish().await;
}

/// Starts the settle with a short deadline and returns once the caller has stopped waiting, with the
/// stub's `new_session` still unanswered.
async fn settle_past_the_deadline(fx: &Fixture) {
    settle_past(fx, Duration::from_millis(500)).await;
}

/// A longer deadline for a test whose first attempt must finish inside it on a loaded machine.
async fn settle_past(fx: &Fixture, deadline: Duration) {
    let agent = fx.agent.clone();
    let task = tokio::spawn(async move { agent.run_settled_handoff_within(2, deadline).await });
    finished(task).await;
    fx.until_rpc("new_session").await;
}

async fn until_gate_free(repo: &str) {
    for _ in 0..200 {
        if !gate_is_held(repo).await {
            return;
        }
    }
    panic!("the detached action never freed the gate");
}

async fn count_of(fx: &Fixture, kind: &str) -> usize {
    fx.rpc_types().await.iter().filter(|t| *t == kind).count()
}

/// Lets a late task that wrongly acts show its effect: nothing here has a signal to wait for.
async fn settle_briefly() {
    tokio::time::sleep(Duration::from_millis(250)).await;
}

#[tokio::test]
async fn an_action_past_its_deadline_keeps_the_gate_and_finishes() {
    let fx = gated_fixture().await;
    queue_settled(&fx, planner()).await;

    settle_past_the_deadline(&fx).await;
    let held_after_deadline = gate_is_held(&fx.repo).await;
    let notices_at_deadline = fx.notices().await;
    fx.release().await;
    until_gate_free(&fx.repo).await;

    assert!(
        held_after_deadline,
        "the action keeps the gate until it ends"
    );
    assert!(notices_at_deadline.is_empty(), "{notices_at_deadline:?}");
    assert_eq!(count_of(&fx, "new_session").await, 1);
    let after_new: Vec<String> = fx
        .rpc_types()
        .await
        .into_iter()
        .skip_while(|t| t != "new_session")
        .collect();
    assert!(
        after_new.len() > 1,
        "the first message follows: {after_new:?}"
    );
    assert!(fx.notices().await.is_empty());
    fx.finish().await;
}

async fn failing_fixture() -> Fixture {
    fixture_with(Stub {
        gated: Some("new_session"),
        fail_once: Some("new_session"),
        ..Stub::default()
    })
    .await
}

#[tokio::test]
async fn an_action_that_fails_after_its_deadline_posts_the_notice_itself() {
    let fx = failing_fixture().await;
    queue_settled(&fx, planner()).await;

    settle_past_the_deadline(&fx).await;
    let notices_at_deadline = fx.notices().await;
    fx.release().await;
    fx.until_notices(1).await;
    until_gate_free(&fx.repo).await;
    settle_briefly().await;

    let notices = fx.notices().await;
    assert!(notices_at_deadline.is_empty(), "{notices_at_deadline:?}");
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert!(notices[0].starts_with("Handoff failed:"), "{notices:?}");
    assert!(notices[0].contains("refused"), "{notices:?}");
    assert!(!notices[0].contains("took longer than"), "{notices:?}");
    assert_eq!(count_of(&fx, "new_session").await, 1, "never retried");
    fx.finish().await;
}

/// The action fails after the caller stopped waiting, then `disturb` happens, then the stub answers.
async fn notices_after_a_late_failure_and(fx: &Fixture, disturb: impl Future<Output = ()>) {
    queue_settled(fx, planner()).await;
    settle_past_the_deadline(fx).await;
    disturb.await;
    fx.release().await;
    until_gate_free(&fx.repo).await;
    settle_briefly().await;
}

#[tokio::test]
async fn a_late_failure_posts_no_notice_once_the_session_is_deleted() {
    let fx = failing_fixture().await;
    let id = fx.agent.session_id.clone();
    let registry = fx.agent.registry().clone();

    notices_after_a_late_failure_and(&fx, async {
        registry.lock().await.remove_session(&id).await.unwrap();
    })
    .await;

    assert!(fx.notices().await.is_empty(), "{:?}", fx.notices().await);
    fx.finish().await;
}

#[tokio::test]
async fn a_late_failure_posts_no_notice_after_the_session_was_shut_down_meanwhile() {
    let fx = failing_fixture().await;
    let agent = fx.agent.clone();

    notices_after_a_late_failure_and(&fx, async {
        let mut state = agent.state.lock().await;
        state.shutdown_generation += 1;
    })
    .await;

    assert!(fx.notices().await.is_empty(), "{:?}", fx.notices().await);
    fx.finish().await;
}

#[tokio::test]
async fn a_retry_still_running_past_the_deadline_does_not_post_the_first_attempts_failure() {
    // The first prompt fails and the retry's prompt waits, so attempt 2 ends at the deadline.
    let fx = fixture_with(Stub {
        gated: Some("prompt"),
        fail_once: Some("prompt"),
        gate_after: 1,
        ..Stub::default()
    })
    .await;
    queue_settled(&fx, planner()).await;

    settle_past(&fx, Duration::from_secs(10)).await;
    let notices_at_deadline = fx.notices().await;
    fx.release().await;
    until_gate_free(&fx.repo).await;
    settle_briefly().await;

    assert_eq!(count_of(&fx, "prompt").await, 2, "one try and one retry");
    // The transcript's own "prompt failed" line is not the agent's handoff notice.
    let posted = |notices: &[String]| notices.iter().any(|n| n.starts_with("Handoff failed"));
    assert!(!posted(&notices_at_deadline), "{notices_at_deadline:?}");
    assert!(!posted(&fx.notices().await), "{:?}", fx.notices().await);
    fx.finish().await;
}
