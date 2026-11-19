// A turn starts atomically: the generation and the status flip in one lock section (#1861).

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
async fn the_state_right_after_a_turn_starts_reads_mid_turn() {
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
async fn the_first_turn_of_a_launched_session_reads_mid_turn_only_once_it_starts() {
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
