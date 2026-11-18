// The deferral slot: one action per agent, taken once the turn that queued it has settled.

use super::{clear, take_queued_handoff, try_queue, HandoffAction, QueuedHandoff};
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
    assert_eq!(queued.sender, Some(("Planner".to_string(), "s-1".to_string())));
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
