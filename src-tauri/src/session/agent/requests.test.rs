// Unit tests for `is_chat_answer`. Scoped to that one function.

use super::*;
use crate::session::agent::AskOption;

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
fn host_ask_card_serialises_host_call_so_the_renderer_offers_notes() {
    let ask = |host_call| PendingRequest::Ask {
        request_id: "r1".into(),
        questions: Vec::new(),
        deadline_at: None,
        host_call,
    };
    assert_eq!(
        serde_json::to_value(ask(true)).unwrap()["hostCall"],
        json!(true)
    );
    // A native ask never carries notes, so the field stays off the wire.
    assert!(serde_json::to_value(ask(false))
        .unwrap()
        .get("hostCall")
        .is_none());
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

fn one_question() -> Vec<AskQuestion> {
    vec![AskQuestion {
        id: "q1".into(),
        question: "Which?".into(),
        header: None,
        options: vec![AskOption {
            label: "A".into(),
            description: None,
            recommended: true,
            reason: None,
        }],
        multi: false,
        recommended: None,
    }]
}

#[test]
fn a_host_ask_answer_carries_the_away_marker_only_when_the_caller_passes_it() {
    let reply = json!({ "answers": [{ "id": "q1", "selectedOptions": ["A"] }] });
    let away = host_ask_reply(&one_question(), &reply, true)
        .unwrap()
        .unwrap();
    assert!(away[0].by_away);
    let human = host_ask_reply(&one_question(), &reply, false)
        .unwrap()
        .unwrap();
    assert!(!human[0].by_away);
}

#[test]
fn a_chat_answer_payload_cannot_claim_away_mode_at_the_top_level() {
    // `chat.answer` forwards the renderer's raw JSON, so the marker must not be read from it.
    let payload = json!({
        "answers": [{ "id": "q1", "selectedOptions": ["A"] }],
        "byAway": true
    });
    let reply = host_ask_reply(&one_question(), &payload, false)
        .unwrap()
        .unwrap();
    assert!(!reply[0].by_away);
}

#[test]
fn a_host_ask_answer_cannot_claim_away_mode_from_inside_an_entry() {
    let answers = json!([{ "id": "q1", "selectedOptions": ["A"], "byAway": true }]);
    let reply = host_ask_reply(&one_question(), &json!({ "answers": answers }), false)
        .unwrap()
        .unwrap();
    assert!(!reply[0].by_away);
}

#[test]
fn the_caller_flag_overrides_an_entry_that_says_otherwise() {
    let answers = json!([{ "id": "q1", "selectedOptions": ["A"], "byAway": true }]);
    let reply = host_ask_reply(&one_question(), &json!({ "answers": answers }), true)
        .unwrap()
        .unwrap();
    assert!(reply[0].by_away);
}

/// Raises a `refract_ask` card through the real host-call router, answers it by the chosen entry
/// point, and returns the text omp receives, so a flipped hardcoded flag in either one fails here.
async fn refract_ask_result_text(by_away: bool) -> String {
    use crate::session::agent::pause_subagents::fixture::fixture;

    let fx = fixture(&[], &[]).await;
    let call = json!({
        "id": "ask-call",
        "toolName": "refract_ask",
        "arguments": { "questions": [{
            "id": "q1",
            "question": "Which?",
            "options": [{ "label": "A" }, { "label": "B" }]
        }] }
    });
    fx.agent.tool_router().handle_call(&fx.agent, &call);
    let mut raised = false;
    for _ in 0..200 {
        let state = fx.agent.state.lock().await;
        raised = state.pending.iter().any(|r| r.request_id() == "ask-call");
        drop(state);
        if raised {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert!(raised, "the refract_ask card was never raised");

    let answer = json!({ "answers": [{ "id": "q1", "selectedOptions": ["A"] }] });
    if by_away {
        fx.agent
            .answer_request_by_away("ask-call".into(), answer)
            .await
            .unwrap();
    } else {
        fx.agent
            .answer_request("ask-call".into(), answer)
            .await
            .unwrap();
    }
    fx.until_rpc("host_tool_result").await;
    let result = fx
        .rpcs()
        .await
        .into_iter()
        .find(|cmd| cmd["type"] == "host_tool_result")
        .unwrap();
    let text = result["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .to_string();
    let marked = result["result"]["details"]["results"][0]
        .get("byAway")
        .is_some();
    assert_eq!(marked, by_away, "saved details disagree with the text");
    fx.finish().await;
    text
}

#[tokio::test]
async fn the_public_answer_path_reports_the_developer_as_the_answerer() {
    let text = refract_ask_result_text(false).await;
    assert!(
        text.starts_with("The developer answered 1 question."),
        "{text}"
    );
}

#[tokio::test]
async fn the_away_answer_path_reports_away_mode_as_the_answerer() {
    let text = refract_ask_result_text(true).await;
    assert!(text.starts_with("Away Mode answered 1 question."), "{text}");
}

#[test]
fn an_unknown_method_name_is_capped_before_it_reaches_the_notice() {
    let frame = json!({ "id": "x1", "method": "m".repeat(500) });
    match classify_dialog(&frame) {
        DialogClassification::Unsupported { id, method } => {
            assert_eq!(id, "x1");
            assert_eq!(method.chars().count(), MAX_METHOD_LENGTH);
        }
        _ => panic!("an unknown method with an id is an unsupported dialog"),
    }
}
