use super::*;
// switch_conversation

fn switch_args(session: &str, conversation: &str) -> serde_json::Value {
    json!({ "session_id": session, "conversation_id": conversation })
}

#[tokio::test]
async fn switch_to_another_listed_conversation_switches_at_once() {
    let fx = fake(vec![conv(1, "a"), conv(2, "b")]).await;

    let result = run_with(&fx, ConvTool::Switch, &switch_args("me", "c2"))
        .await
        .unwrap();

    assert_eq!(
        result,
        json!({ "outcome": "switched", "id": "me", "conversation_id": "c2" })
    );
    assert_eq!(fx.calls()[1], "switch:me:c2.jsonl");
}

#[tokio::test]
async fn switch_to_the_current_conversation_is_unchanged_and_does_nothing() {
    let fx = fake(vec![conv(1, "a"), conv(2, "b")]).await;

    let result = run_with(&fx, ConvTool::Switch, &switch_args("me", "c1"))
        .await
        .unwrap();

    assert_eq!(
        result,
        json!({ "outcome": "unchanged", "id": "me", "conversation_id": "c1" })
    );
    assert!(fx.calls().is_empty());
}

#[tokio::test]
async fn switch_mid_turn_is_scheduled() {
    let mut fx = fake(vec![conv(1, "a"), conv(2, "b")]).await;
    fx.mid_turn = true;

    let result = run_with(&fx, ConvTool::Switch, &switch_args("me", "c2"))
        .await
        .unwrap();

    assert_eq!(
        result,
        json!({ "outcome": "scheduled", "id": "me", "conversation_id": "c2" })
    );
    assert_eq!(fx.calls().len(), 1, "{:?}", fx.calls());
}

#[tokio::test]
async fn switch_to_a_conversation_the_session_does_not_have_is_not_found() {
    let fx = fake(vec![conv(1, "a")]).await;

    let result = run_with(&fx, ConvTool::Switch, &switch_args("me", "c9")).await;

    assert_eq!(code(result), NOT_FOUND);
    assert!(fx.calls().is_empty());
}

#[tokio::test]
async fn switch_in_a_sibling_the_developer_denies_changes_nothing() {
    let mut fx = fake(vec![conv(1, "a"), conv(2, "b")]).await;
    fx.approve = false;

    let result = run_with(&fx, ConvTool::Switch, &switch_args("side", "c2")).await;

    assert_eq!(code(result), DENIED);
    assert_eq!(fx.cards.lock().unwrap().len(), 1);
    assert!(fx.calls().is_empty());
}

#[tokio::test]
async fn switch_in_a_paused_session_is_invalid_state() {
    let fx = fake(vec![conv(1, "a"), conv(2, "b")]).await;
    fx.paused.lock().unwrap().insert("kid".into());

    let result = run_with(&fx, ConvTool::Switch, &switch_args("kid", "c2")).await;

    assert_eq!(code(result), INVALID_STATE);
    assert!(fx.calls().is_empty());
}
