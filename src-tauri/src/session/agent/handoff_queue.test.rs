// The deferral slot: one action per agent, taken once the turn that queued it has settled.

use super::{clear, take_queued_handoff, try_queue, HandoffAction, QueueOutcome, QueuedHandoff};
use crate::session::agent::pause_subagents::fixture::fixture;

fn new_with(prompt: &str) -> HandoffAction {
    HandoffAction::New {
        prompt: prompt.to_string(),
    }
}

#[tokio::test]
async fn try_queue_accepts_one_action_and_refuses_a_second() {
    let fx = fixture(&[], &[]).await;
    let mut state = fx.agent.state.lock().await;
    state.turn_generation = 3;

    try_queue(&mut state, new_with("first"), None).unwrap();
    let err = try_queue(
        &mut state,
        HandoffAction::Switch {
            file: "b.jsonl".into(),
        },
        None,
    )
    .unwrap_err();

    assert_eq!(err.code, "invalid-state");
    assert_eq!(err.message, "a handoff is already queued for this turn");
    assert_eq!(
        state.queued_handoff,
        Some(QueuedHandoff {
            generation: 3,
            action: new_with("first"),
            sender: None,
        })
    );
    drop(state);
    fx.finish().await;
}

#[tokio::test]
async fn the_sender_is_kept_for_the_envelope() {
    let fx = fixture(&[], &[]).await;
    let mut state = fx.agent.state.lock().await;

    try_queue(
        &mut state,
        new_with("note"),
        Some(("Planner".into(), "s-1".into())),
    )
    .unwrap();

    let queued = state.queued_handoff.clone().unwrap();
    assert_eq!(
        queued.sender,
        Some(("Planner".to_string(), "s-1".to_string()))
    );
    drop(state);
    fx.finish().await;
}

#[tokio::test]
async fn take_queued_handoff_empties_the_slot() {
    let fx = fixture(&[], &[]).await;
    let mut state = fx.agent.state.lock().await;
    state.turn_generation = 1;
    try_queue(&mut state, new_with("go"), None).unwrap();

    let taken = take_queued_handoff(&mut state, 2).unwrap();

    assert_eq!(taken.action, new_with("go"));
    assert!(state.queued_handoff.is_none());
    assert!(take_queued_handoff(&mut state, 2).is_none());
    // The slot is free again for the next turn.
    try_queue(&mut state, new_with("again"), None).unwrap();
    drop(state);
    fx.finish().await;
}

#[tokio::test]
async fn take_queued_handoff_leaves_an_action_from_the_running_turn() {
    let fx = fixture(&[], &[]).await;
    let mut state = fx.agent.state.lock().await;
    state.turn_generation = 5;
    try_queue(&mut state, new_with("later"), None).unwrap();

    assert!(take_queued_handoff(&mut state, 4).is_none());
    assert!(take_queued_handoff(&mut state, 5).is_none());
    assert!(state.queued_handoff.is_some());
    drop(state);
    fx.finish().await;
}

#[tokio::test]
async fn clear_empties_the_slot() {
    let fx = fixture(&[], &[]).await;
    let mut state = fx.agent.state.lock().await;
    try_queue(&mut state, new_with("drop me"), None).unwrap();

    clear(&mut state);

    assert!(state.queued_handoff.is_none());
    clear(&mut state);
    assert!(state.queued_handoff.is_none());
    drop(state);
    fx.finish().await;
}

// `queue_handoff`: the public entry the tools use.

#[tokio::test]
async fn queue_handoff_queues_when_a_turn_is_running() {
    let fx = fixture(&[], &[]).await;
    {
        let mut state = fx.agent.state.lock().await;
        state.status = crate::session::agent::SessionStatus::Working;
        state.turn_generation = 3;
    }

    let outcome = fx
        .agent
        .queue_handoff(new_with("go"), Some(("Planner".into(), "s-1".into())))
        .await
        .unwrap();

    assert_eq!(outcome, QueueOutcome::Queued);
    assert_eq!(
        fx.agent.state.lock().await.queued_handoff,
        Some(QueuedHandoff {
            generation: 3,
            action: new_with("go"),
            sender: Some(("Planner".to_string(), "s-1".to_string())),
        })
    );
    fx.finish().await;
}

#[tokio::test]
async fn queue_handoff_refuses_a_second_action() {
    let fx = fixture(&[], &[]).await;
    queued_mid_turn(&fx).await;

    let err = fx
        .agent
        .queue_handoff(new_with("second"), None)
        .await
        .unwrap_err();

    assert_eq!(err.code, "invalid-state");
    assert_eq!(
        fx.agent
            .state
            .lock()
            .await
            .queued_handoff
            .clone()
            .unwrap()
            .action,
        new_with("never")
    );
    fx.finish().await;
}

#[tokio::test]
async fn queue_handoff_reports_not_mid_turn_when_idle() {
    let fx = fixture(&[], &[]).await;
    {
        let mut state = fx.agent.state.lock().await;
        state.status = crate::session::agent::SessionStatus::Idle;
        state.turn_generation = 4;
    }

    let outcome = fx.agent.queue_handoff(new_with("go"), None).await.unwrap();

    assert_eq!(outcome, QueueOutcome::NotMidTurn);
    assert!(fx.agent.state.lock().await.queued_handoff.is_none());
    fx.finish().await;
}

#[tokio::test]
async fn queue_handoff_reports_not_mid_turn_when_stopped() {
    let fx = fixture(&[], &[]).await;
    {
        let mut state = fx.agent.state.lock().await;
        state.status = crate::session::agent::SessionStatus::Stopped;
        state.turn_generation = 5;
    }

    let outcome = fx.agent.queue_handoff(new_with("go"), None).await.unwrap();

    assert_eq!(outcome, QueueOutcome::NotMidTurn);
    assert!(fx.agent.state.lock().await.queued_handoff.is_none());
    fx.finish().await;
}

// Cancellation: a stopped turn must not hand off (#1861).

/// A running turn with an action queued against it.
async fn queued_mid_turn(fx: &crate::session::agent::pause_subagents::fixture::Fixture) {
    let mut state = fx.agent.state.lock().await;
    state.status = crate::session::agent::SessionStatus::Working;
    state.turn_generation = 1;
    try_queue(&mut state, new_with("never"), None).unwrap();
}

#[tokio::test]
async fn chat_stop_empties_the_slot() {
    let fx = fixture(&[], &[]).await;
    queued_mid_turn(&fx).await;

    // `stop` waits for the Session to settle, so run it aside and release it afterwards.
    let agent = fx.agent.clone();
    let stopping = tokio::spawn(async move { agent.stop().await });
    for _ in 0..200 {
        if fx.agent.state.lock().await.queued_handoff.is_none() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert!(fx.agent.state.lock().await.queued_handoff.is_none());

    fx.agent
        .set_status(crate::session::agent::SessionStatus::Idle, None, None)
        .await;
    stopping.await.unwrap().unwrap();
    fx.finish().await;
}

#[tokio::test]
async fn shutdown_empties_the_slot() {
    let fx = fixture(&[], &[]).await;
    queued_mid_turn(&fx).await;

    fx.agent.shutdown().await;

    assert!(fx.agent.state.lock().await.queued_handoff.is_none());
}

#[tokio::test]
async fn a_process_exit_empties_the_slot() {
    let fx = fixture(&[], &[]).await;
    queued_mid_turn(&fx).await;
    let proc = fx.agent.state.lock().await.process.clone().unwrap();

    fx.agent.handle_exit(&proc, Some(1), false).await;

    assert!(fx.agent.state.lock().await.queued_handoff.is_none());
    proc.stop().await;
}

#[tokio::test]
async fn a_requested_stop_exit_empties_the_slot() {
    let fx = fixture(&[], &[]).await;
    queued_mid_turn(&fx).await;
    let proc = fx.agent.state.lock().await.process.clone().unwrap();
    fx.agent.state.lock().await.stop_requested = true;

    fx.agent.handle_exit(&proc, Some(0), true).await;

    assert!(fx.agent.state.lock().await.queued_handoff.is_none());
    proc.stop().await;
}

#[tokio::test]
async fn an_aborted_turn_drops_the_action_at_settle() {
    let fx = fixture(&[], &[]).await;
    queued_mid_turn(&fx).await;
    fx.agent.state.lock().await.turn_abort_requested = true;

    fx.agent
        .handle_frame(serde_json::json!({ "type": "session_settled" }))
        .await;

    assert!(fx.agent.state.lock().await.queued_handoff.is_none());
    // The flag was read before it was cleared, and nothing was started.
    assert!(!fx.rpc_types().await.iter().any(|t| t == "new_session"));
    fx.finish().await;
}
