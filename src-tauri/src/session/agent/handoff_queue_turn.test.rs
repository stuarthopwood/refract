// Turn start and settle set the generation and the status together, so a queue sees one state (#1861).

use serde_json::json;

use super::{HandoffAction, QueueOutcome};
use crate::session::agent::pause_subagents::fixture::fixture;
use crate::session::agent::SessionStatus;

fn action() -> HandoffAction {
    HandoffAction::New {
        prompt: "later".into(),
    }
}

#[tokio::test]
async fn begin_turn_leaves_a_working_session_at_an_odd_generation_that_queues() {
    let fx = fixture(&[], &[]).await;
    {
        let mut state = fx.agent.state.lock().await;
        state.status = SessionStatus::Idle;
        state.turn_generation = 2;

        fx.agent.begin_turn(&mut state);

        assert_eq!(state.status, SessionStatus::Working);
        assert_eq!(state.turn_generation, 3);
    }

    let outcome = fx.agent.queue_handoff(action(), None, false).await.unwrap();

    assert_eq!(outcome, QueueOutcome::Queued);
    fx.finish().await;
}

#[tokio::test]
async fn a_launched_session_at_the_odd_starting_generation_queues_only_once_agent_start_arrives() {
    let fx = fixture(&[], &[]).await;
    {
        // A launched Session idles at the odd starting generation, which is not a running turn.
        let mut state = fx.agent.state.lock().await;
        state.status = SessionStatus::Idle;
        state.turn_generation = 1;
    }
    let before = fx.agent.queue_handoff(action(), None, false).await.unwrap();

    fx.agent
        .handle_frame(json!({ "type": "agent_start" }))
        .await;
    let during = fx.agent.queue_handoff(action(), None, false).await.unwrap();

    assert_eq!(before, QueueOutcome::NotMidTurn);
    assert_eq!(during, QueueOutcome::Queued);
    fx.finish().await;
}

#[tokio::test]
async fn begin_turn_leaves_an_already_odd_generation_alone() {
    let fx = fixture(&[], &[]).await;
    {
        let mut state = fx.agent.state.lock().await;
        state.status = SessionStatus::Idle;
        state.turn_generation = 1;

        fx.agent.begin_turn(&mut state);

        assert_eq!(state.turn_generation, 1);
        assert_eq!(state.status, SessionStatus::Working);
    }
    fx.finish().await;
}

#[tokio::test]
async fn a_settle_frame_leaves_an_even_generation_and_an_idle_status() {
    let fx = fixture(&[], &[]).await;
    {
        let mut state = fx.agent.state.lock().await;
        state.status = SessionStatus::Working;
        state.turn_generation = 3;
    }

    fx.agent
        .handle_frame(json!({ "type": "session_settled" }))
        .await;

    let state = fx.agent.state.lock().await;
    assert_eq!(state.turn_generation, 4);
    assert_eq!(state.status, SessionStatus::Idle);
    drop(state);
    fx.finish().await;
}
