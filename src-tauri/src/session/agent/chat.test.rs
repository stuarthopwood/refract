use super::*;

#[test]
fn a_paused_target_holds_whatever_its_response_says() {
    assert_eq!(
        delivery_of(true, &json!({ "queued": true })),
        MessageDelivery::Held
    );
    assert_eq!(delivery_of(true, &Value::Null), MessageDelivery::Held);
}

#[test]
fn a_working_target_queues_the_message() {
    assert_eq!(
        delivery_of(false, &json!({ "queued": true })),
        MessageDelivery::Queued
    );
}

#[test]
fn an_idle_target_takes_the_message_at_once() {
    assert_eq!(
        delivery_of(false, &json!({ "queued": false })),
        MessageDelivery::Sent
    );
    assert_eq!(delivery_of(false, &json!({})), MessageDelivery::Sent);
}

#[test]
fn only_an_idle_non_drain_prompt_that_asks_for_it_is_decorated() {
    assert!(should_decorate(false, false, true));
    assert!(!should_decorate(true, false, true));
    assert!(!should_decorate(false, true, true));
}

#[test]
fn session_messages_are_never_decorated() {
    assert!(!should_decorate(false, false, false));
}

#[tokio::test]
async fn a_rejected_prompt_keeps_the_notice_for_the_next_send() {
    use crate::session::agent::pause_subagents::fixture::{fixture_with, Stub};
    let fx = fixture_with(Stub {
        fail_once: Some("prompt"),
        ..Stub::default()
    })
    .await;
    fx.agent.state.lock().await.pending_agent_notice = vec!["Handoff failed: boom".to_string()];

    let err = fx.agent.send("first".to_string(), None).await.unwrap_err();
    assert_eq!(err.code, "prompt-failed");
    assert_eq!(
        fx.agent.state.lock().await.pending_agent_notice,
        ["Handoff failed: boom"]
    );

    fx.agent.send("second".to_string(), None).await.unwrap();

    let prompts: Vec<String> = fx
        .rpcs()
        .await
        .iter()
        .filter(|cmd| cmd["type"] == "prompt")
        .map(|cmd| cmd["message"].as_str().unwrap().to_string())
        .collect();
    // The agent never saw the first prompt, so the second one carries the notice.
    assert_eq!(prompts.len(), 2);
    assert_eq!(prompts[1], "[Refract] Handoff failed: boom\n\nsecond");
    assert!(fx.agent.state.lock().await.pending_agent_notice.is_empty());
    fx.finish().await;
}

async fn prompts(fx: &crate::session::agent::pause_subagents::fixture::Fixture) -> Vec<String> {
    fx.rpcs()
        .await
        .iter()
        .filter(|cmd| cmd["type"] == "prompt")
        .map(|cmd| cmd["message"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn checklist_item_is_held_while_paused() {
    use crate::session::agent::pause_subagents::fixture::{fixture_with, Stub};
    let fx = fixture_with(Stub::default()).await;
    fx.agent.state.lock().await.pause.hold_for_test(Vec::new());

    let delivery = fx.agent.send_checklist_item("<turn/>".to_string()).await;

    assert_eq!(delivery.unwrap(), MessageDelivery::Held);
    assert!(prompts(&fx).await.is_empty());
    fx.finish().await;
}

#[tokio::test]
async fn checklist_item_is_queued_while_busy() {
    use crate::session::agent::pause_subagents::fixture::{fixture_with, Stub};
    let fx = fixture_with(Stub {
        queue_prompts: true,
        ..Stub::default()
    })
    .await;
    fx.agent.state.lock().await.status = SessionStatus::Working;

    let delivery = fx.agent.send_checklist_item("<turn/>".to_string()).await;

    assert_eq!(delivery.unwrap(), MessageDelivery::Queued);
    fx.finish().await;
}

#[tokio::test]
async fn checklist_item_is_sent_undecorated_when_idle() {
    use crate::session::agent::pause_subagents::fixture::{fixture_with, Stub};
    let fx = fixture_with(Stub::default()).await;

    let delivery = fx.agent.send_checklist_item("<turn/>".to_string()).await;

    assert_eq!(delivery.unwrap(), MessageDelivery::Sent);
    assert_eq!(prompts(&fx).await, ["<turn/>"]);
    fx.finish().await;
}

#[tokio::test]
async fn checklist_item_does_not_consume_a_notice() {
    use crate::session::agent::pause_subagents::fixture::{fixture_with, Stub};
    let fx = fixture_with(Stub::default()).await;
    fx.agent.state.lock().await.pending_agent_notice = vec!["Handoff failed: boom".to_string()];
    fx.agent.state.lock().await.checklist_line_due = true;

    fx.agent
        .send_checklist_item("<turn/>".to_string())
        .await
        .unwrap();

    let state = fx.agent.state.lock().await;
    assert_eq!(state.pending_agent_notice, ["Handoff failed: boom"]);
    assert!(state.checklist_line_due);
    drop(state);
    assert_eq!(prompts(&fx).await, ["<turn/>"]);
    fx.finish().await;
}

#[tokio::test]
async fn send_session_message_behaviour_unchanged() {
    use crate::session::agent::pause_subagents::fixture::{fixture_with, Stub};
    let fx = fixture_with(Stub::default()).await;

    let delivery = fx.agent.send_session_message("<env/>".to_string()).await;

    assert_eq!(delivery.unwrap(), MessageDelivery::Sent);
    assert_eq!(prompts(&fx).await, ["<env/>"]);
    fx.finish().await;
}
