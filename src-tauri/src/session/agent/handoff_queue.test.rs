// The deferral slot: one action per agent, taken once the turn that queued it has settled.

use super::{clear, take_queued_handoff, try_queue, HandoffAction, QueueOutcome, QueuedHandoff};
use crate::session::agent::pause_subagents::fixture::{fixture, Fixture};
use crate::store::registry::SessionPatch;

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

#[tokio::test]
async fn queue_handoff_reports_not_mid_turn_for_an_idle_agent_with_the_launch_generation() {
    let fx = fixture(&[], &[]).await;
    {
        let mut state = fx.agent.state.lock().await;
        // A launched Session starts at the odd "not yet settled" generation and no turn has run.
        state.status = crate::session::agent::SessionStatus::Idle;
        assert_eq!(state.turn_generation % 2, 1);
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

// The agent hears about a failed handoff once, in front of the user's next prompt (#1861).

async fn sent_prompts(
    fx: &crate::session::agent::pause_subagents::fixture::Fixture,
) -> Vec<String> {
    fx.rpcs()
        .await
        .iter()
        .filter(|cmd| cmd["type"] == "prompt")
        .map(|cmd| cmd["message"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn the_failure_notice_prefixes_the_next_prompt_once_then_clears() {
    let fx = fixture(&[], &[]).await;
    fx.agent.state.lock().await.pending_agent_notice = Some("Handoff failed: boom".to_string());

    fx.agent.send("hello".to_string(), None).await.unwrap();
    fx.agent.send("again".to_string(), None).await.unwrap();

    assert_eq!(
        sent_prompts(&fx).await,
        ["[Refract] Handoff failed: boom\n\nhello", "again"]
    );
    assert!(fx.agent.state.lock().await.pending_agent_notice.is_none());
    fx.finish().await;
}

#[tokio::test]
async fn a_session_envelope_leaves_the_notice_for_the_users_prompt() {
    let fx = fixture(&[], &[]).await;
    fx.agent.state.lock().await.pending_agent_notice = Some("Handoff failed: boom".to_string());

    fx.agent
        .send_session_message("<envelope/>".to_string())
        .await
        .unwrap();

    assert_eq!(sent_prompts(&fx).await, ["<envelope/>"]);
    assert!(fx.agent.state.lock().await.pending_agent_notice.is_some());
    fx.finish().await;
}

// The failure reason reaches the agent's prompt, so it is one capped line.

#[test]
fn the_failure_notice_is_one_capped_line_without_bidi_characters() {
    let notice = super::failed_notice(&format!("a\nb\u{202E}c{}", "x".repeat(500)));

    assert!(notice.starts_with("Handoff failed: a b"));
    assert!(!notice.contains(['\n', '\u{202E}']));
    assert!(notice.chars().count() < 250);
}

// A deferred action is checked again when its turn settles (#1861).

async fn settle_with_queued(
    fx: &crate::session::agent::pause_subagents::fixture::Fixture,
    sender: Option<(String, String)>,
) {
    {
        let mut state = fx.agent.state.lock().await;
        state.status = crate::session::agent::SessionStatus::Working;
        state.turn_generation = 1;
        try_queue(&mut state, new_with("later"), sender).unwrap();
        // Settling moves the generation on to the next even number.
        state.turn_generation = 2;
        state.status = crate::session::agent::SessionStatus::Idle;
    }
    fx.agent.run_settled_handoff(2).await;
}

#[tokio::test]
async fn a_deferred_action_is_dropped_when_the_session_is_being_deleted() {
    let fx = fixture(&[], &[]).await;
    let _claim =
        crate::ipc::sessions_lifecycle::delete_in_flight::claim(&fx.agent.session_id).unwrap();

    settle_with_queued(&fx, None).await;

    assert!(fx.agent.state.lock().await.queued_handoff.is_none());
    assert!(!fx.rpc_types().await.iter().any(|t| t == "new_session"));
    assert_eq!(
        fx.notices().await,
        ["Handoff dropped: the Session is being deleted"]
    );
    fx.finish().await;
}

#[tokio::test]
async fn a_deferred_action_is_dropped_when_the_sending_session_is_gone() {
    let fx = fixture(&[], &[]).await;

    settle_with_queued(&fx, Some(("Planner".into(), "no-such-session".into()))).await;

    assert!(!fx.rpc_types().await.iter().any(|t| t == "new_session"));
    assert_eq!(
        fx.notices().await,
        ["Handoff dropped: the sending Session no longer exists"]
    );
    fx.finish().await;
}

#[tokio::test]
async fn a_deferred_action_is_dropped_when_the_session_is_archived() {
    let fx = fixture(&[], &[]).await;
    patch(
        &fx,
        &fx.agent.session_id,
        SessionPatch {
            archived_at: Some(Some("2026-11-12T00:00:00.000Z".into())),
            ..Default::default()
        },
    )
    .await;

    settle_with_queued(&fx, None).await;

    assert!(!fx.rpc_types().await.iter().any(|t| t == "new_session"));
    assert_eq!(
        fx.notices().await,
        ["Handoff dropped: the Session is archived"]
    );
    fx.finish().await;
}

#[tokio::test]
async fn a_deferred_action_is_dropped_when_the_session_is_paused() {
    let fx = fixture(&[], &[]).await;
    patch(
        &fx,
        &fx.agent.session_id,
        SessionPatch {
            paused_held: Some(Some(Vec::new())),
            ..Default::default()
        },
    )
    .await;

    settle_with_queued(&fx, None).await;

    assert!(!fx.rpc_types().await.iter().any(|t| t == "new_session"));
    assert_eq!(
        fx.notices().await,
        ["Handoff dropped: the Session is paused"]
    );
    fx.finish().await;
}

#[tokio::test]
async fn a_deferred_action_is_dropped_when_the_target_is_now_the_senders_ancestor() {
    let fx = fixture(&[], &[]).await;
    fx.add_session("sender", &[], false).await;
    patch(
        &fx,
        "sender",
        SessionPatch {
            parent_session_id: Some(Some(fx.agent.session_id.clone())),
            ..Default::default()
        },
    )
    .await;

    settle_with_queued(&fx, Some(("Planner".into(), "sender".into()))).await;

    assert!(!fx.rpc_types().await.iter().any(|t| t == "new_session"));
    assert_eq!(
        fx.notices().await,
        ["Handoff dropped: the Session is now an ancestor of the sending Session"]
    );
    fx.finish().await;
}

async fn patch(fx: &Fixture, id: &str, patch: SessionPatch) {
    let registry = fx.agent.registry().clone();
    registry
        .lock()
        .await
        .update_session(id, patch)
        .await
        .unwrap();
}
