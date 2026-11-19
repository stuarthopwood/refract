use super::*;
// new_conversation

#[tokio::test]
async fn new_checks_its_arguments_before_touching_anything() {
    let fx = fake(vec![]).await;

    assert_eq!(
        code(run_with(&fx, ConvTool::New, &json!({})).await),
        INVALID_INPUT
    );
    assert!(fx.calls().is_empty());
}

#[tokio::test]
async fn new_in_an_idle_own_session_starts_at_once_as_a_handoff() {
    let fx = fake(vec![]).await;

    let result = run_with(&fx, ConvTool::New, &json!({ "prompt": "go" }))
        .await
        .unwrap();

    assert_eq!(result, json!({ "outcome": "started", "id": "me" }));
    assert_eq!(fx.calls()[1], "start:me:true:go");
}

#[tokio::test]
async fn new_in_a_mid_turn_session_is_scheduled_and_nothing_starts() {
    let mut fx = fake(vec![]).await;
    fx.mid_turn = true;

    let result = run_with(&fx, ConvTool::New, &json!({ "prompt": "go" }))
        .await
        .unwrap();

    assert_eq!(result, json!({ "outcome": "scheduled", "id": "me" }));
    assert_eq!(fx.calls().len(), 1, "{:?}", fx.calls());
}

#[tokio::test]
async fn new_in_a_sibling_asks_first_and_sends_the_prompt_in_an_envelope() {
    let fx = fake(vec![]).await;
    let args = json!({ "prompt": "build it", "session_id": "side" });

    let result = run_with(&fx, ConvTool::New, &args).await.unwrap();

    assert_eq!(result, json!({ "outcome": "started", "id": "side" }));
    assert_eq!(fx.cards.lock().unwrap().len(), 1);
    assert!(
        fx.calls()[1].starts_with("start:side:false:"),
        "{:?}",
        fx.calls()
    );
    assert!(fx.calls()[1].contains("build it"));
}

#[tokio::test]
async fn new_in_a_sibling_the_developer_denies_changes_nothing() {
    let mut fx = fake(vec![]).await;
    fx.approve = false;
    let args = json!({ "prompt": "build it", "session_id": "side" });

    assert_eq!(code(run_with(&fx, ConvTool::New, &args).await), DENIED);
    assert_eq!(fx.cards.lock().unwrap().len(), 1);
    assert!(fx.calls().is_empty());
}

#[tokio::test]
async fn new_in_a_paused_session_is_invalid_state() {
    let fx = fake(vec![]).await;
    fx.paused.lock().unwrap().insert("kid".into());
    let args = json!({ "prompt": "go", "session_id": "kid" });

    assert_eq!(
        code(run_with(&fx, ConvTool::New, &args).await),
        INVALID_STATE
    );
    assert!(fx.calls().is_empty());
}
