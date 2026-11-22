// Unit tests for `is_chat_answer`. Scoped to that one function.

use super::*;

#[test]
fn is_chat_answer_accepts_every_documented_shape() {
    assert!(is_chat_answer(&json!({ "approve": true })));
    assert!(is_chat_answer(&json!({ "approve": false })));
    assert!(is_chat_answer(&json!({ "value": "some text" })));
    assert!(is_chat_answer(&json!({ "value": "" })));
    assert!(is_chat_answer(&json!({ "confirmed": true })));
    assert!(is_chat_answer(&json!({ "confirmed": false })));
    assert!(is_chat_answer(&json!({ "cancelled": true })));
}

#[test]
fn is_chat_answer_rejects_non_objects() {
    assert!(!is_chat_answer(&Value::Null));
    assert!(!is_chat_answer(&json!("a string")));
    assert!(!is_chat_answer(&json!(42)));
    assert!(!is_chat_answer(&json!([true])));
}

#[test]
fn is_chat_answer_rejects_wrong_field_types() {
    assert!(!is_chat_answer(&json!({ "approve": "yes" })));
    assert!(!is_chat_answer(&json!({ "value": 123 })));
    assert!(!is_chat_answer(&json!({ "confirmed": "true" })));
    // `cancelled` only means anything as the literal `true`.
    assert!(!is_chat_answer(&json!({ "cancelled": false })));
    assert!(!is_chat_answer(&json!({ "cancelled": "true" })));
}

#[test]
fn is_chat_answer_rejects_an_object_with_none_of_the_recognised_fields() {
    assert!(!is_chat_answer(&json!({})));
    assert!(!is_chat_answer(&json!({ "somethingElse": true })));
}

#[tokio::test]
async fn answering_a_host_ask_nobody_waits_for_reports_request_gone_and_closes_the_card() {
    use crate::omp::transcript::TranscriptItem;
    use crate::session::agent::pause_subagents::fixture::fixture;

    let fx = fixture(&[], &[]).await;
    fx.agent
        .state
        .lock()
        .await
        .pending
        .push(PendingRequest::Ask {
            request_id: "call-9".into(),
            questions: Vec::new(),
            deadline_at: None,
            host_call: true,
        });

    let err = fx
        .agent
        .answer_request("call-9".into(), json!({ "cancelled": true }))
        .await
        .unwrap_err();

    assert_eq!(err.code, "request-gone");
    let state = fx.agent.state.lock().await;
    assert!(state.pending.is_empty());
    let resolved = state
        .transcript
        .items()
        .iter()
        .find_map(|item| match &**item {
            TranscriptItem::Request {
                request_id,
                resolved,
                ..
            } if request_id == "call-9" => Some(*resolved),
            _ => None,
        });
    assert_eq!(resolved, Some(Some(RequestResolution::Cancelled)));
    drop(state);
    fx.finish().await;
}

#[tokio::test]
async fn a_valid_answer_to_a_host_ask_nobody_waits_for_is_request_gone_and_cancelled() {
    use crate::omp::transcript::TranscriptItem;
    use crate::session::agent::pause_subagents::fixture::fixture;

    let fx = fixture(&[], &[]).await;
    fx.agent
        .state
        .lock()
        .await
        .pending
        .push(PendingRequest::Ask {
            request_id: "call-8".into(),
            questions: vec![AskQuestion {
                id: "q1".into(),
                question: "Which?".into(),
                header: None,
                options: vec![AskOption {
                    label: "A".into(),
                    description: None,
                    recommended: false,
                    reason: None,
                }],
                multi: false,
                recommended: None,
            }],
            deadline_at: None,
            host_call: true,
        });

    let err = fx
        .agent
        .answer_request(
            "call-8".into(),
            json!({ "answers": [{ "id": "q1", "selectedOptions": ["A"] }] }),
        )
        .await
        .unwrap_err();

    assert_eq!(err.code, "request-gone");
    let state = fx.agent.state.lock().await;
    assert!(state.pending.is_empty());
    let resolved = state
        .transcript
        .items()
        .iter()
        .find_map(|item| match &**item {
            TranscriptItem::Request {
                request_id,
                resolved,
                ..
            } if request_id == "call-8" => Some(*resolved),
            _ => None,
        });
    assert_eq!(resolved, Some(Some(RequestResolution::Cancelled)));
    drop(state);
    fx.finish().await;
}
