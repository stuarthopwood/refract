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

#[test]
fn a_multibyte_method_name_is_capped_on_character_boundaries() {
    for raw in ["é".repeat(100), "😀".repeat(100)] {
        let frame = json!({ "id": "x1", "method": raw });
        match classify_dialog(&frame) {
            DialogClassification::Unsupported { method, .. } => {
                assert_eq!(method.chars().count(), MAX_METHOD_LENGTH);
                assert!(std::str::from_utf8(method.as_bytes()).is_ok());
            }
            _ => panic!("an unknown method with an id is an unsupported dialog"),
        }
    }
}

#[test]
fn control_characters_are_stripped_from_the_method_name() {
    let frame = json!({ "id": "x1", "method": "fo\nrm\u{1b}[31m" });
    match classify_dialog(&frame) {
        DialogClassification::Unsupported { method, .. } => assert_eq!(method, "form[31m"),
        _ => panic!("an unknown method with an id is an unsupported dialog"),
    }
}

#[test]
fn a_missing_non_string_or_empty_method_is_named_unknown() {
    for frame in [
        json!({ "id": "x1" }),
        json!({ "id": "x1", "method": 7 }),
        json!({ "id": "x1", "method": "" }),
        json!({ "id": "x1", "method": "\n\u{1b}" }),
    ] {
        match classify_dialog(&frame) {
            DialogClassification::Unsupported { id, method } => {
                assert_eq!(id, "x1");
                assert_eq!(method, "unknown");
            }
            _ => panic!("expected an unsupported dialog for {frame}"),
        }
    }
}

fn form_card(html: &str) -> PendingRequest {
    PendingRequest::Form {
        request_id: "f1".into(),
        html: html.into(),
        deadline_at: None,
    }
}

#[test]
fn a_form_frame_with_html_becomes_a_form_card() {
    let frame = json!({ "id": "f1", "method": "form", "html": "<form></form>" });
    match classify_dialog(&frame) {
        DialogClassification::Request(PendingRequest::Form {
            request_id,
            html,
            deadline_at,
        }) => {
            assert_eq!(request_id, "f1");
            assert_eq!(html, "<form></form>");
            assert_eq!(deadline_at, None);
        }
        _ => panic!("a form frame with html is a form card"),
    }
}

#[test]
fn a_form_timeout_is_milliseconds_from_now() {
    let before = now_ms();
    let frame = json!({ "id": "f1", "method": "form", "html": "<form></form>", "timeout": 30000 });
    let DialogClassification::Request(PendingRequest::Form {
        deadline_at: Some(deadline),
        ..
    }) = classify_dialog(&frame)
    else {
        panic!("a form frame with a timeout carries a deadline");
    };
    assert!((before + 30_000..=now_ms() + 30_000).contains(&deadline));
}

#[test]
fn an_unusable_form_timeout_leaves_no_deadline() {
    for timeout in [json!(-1), json!("30000"), json!(null)] {
        let frame =
            json!({ "id": "f1", "method": "form", "html": "<form></form>", "timeout": timeout });
        assert!(
            matches!(
                classify_dialog(&frame),
                DialogClassification::Request(PendingRequest::Form {
                    deadline_at: None,
                    ..
                })
            ),
            "timeout {timeout}"
        );
    }
}

#[test]
fn a_form_frame_without_usable_html_is_unsupported() {
    for frame in [
        json!({ "id": "f1", "method": "form" }),
        json!({ "id": "f1", "method": "form", "html": 7 }),
        json!({ "id": "f1", "method": "form", "html": null }),
    ] {
        match classify_dialog(&frame) {
            DialogClassification::Unsupported { id, method } => {
                assert_eq!(id, "f1");
                assert_eq!(method, "form");
            }
            _ => panic!("expected an unsupported dialog for {frame}"),
        }
    }
}

#[test]
fn an_id_less_form_frame_is_ignored() {
    let frame = json!({ "method": "form", "html": "<form></form>" });
    assert!(matches!(
        classify_dialog(&frame),
        DialogClassification::Ignore
    ));
}

#[test]
fn a_form_card_serialises_with_the_form_kind_and_optional_deadline() {
    let card = serde_json::to_value(form_card("<form></form>")).unwrap();
    assert_eq!(
        card,
        json!({ "kind": "form", "requestId": "f1", "html": "<form></form>" })
    );
    let with_deadline = PendingRequest::Form {
        request_id: "f1".into(),
        html: String::new(),
        deadline_at: Some(5),
    };
    assert_eq!(
        serde_json::to_value(with_deadline).unwrap()["deadlineAt"],
        5
    );
}

#[test]
fn a_form_answer_forwards_data_exactly() {
    let data = json!({ "title": "Ship it", "count": 3, "ratio": 0.5, "tags": ["a", "b"] });
    let reply = build_dialog_response("f1", &form_card(""), &json!({ "data": data })).unwrap();
    assert_eq!(
        reply,
        json!({ "type": "extension_ui_response", "id": "f1", "data": data })
    );
}

#[test]
fn a_form_cancel_forwards_cancelled() {
    let reply = build_dialog_response("f1", &form_card(""), &json!({ "cancelled": true })).unwrap();
    assert_eq!(
        reply,
        json!({ "type": "extension_ui_response", "id": "f1", "cancelled": true })
    );
}

#[test]
fn a_form_deadline_cancel_forwards_timed_out() {
    let answer = json!({ "cancelled": true, "timedOut": true });
    let reply = build_dialog_response("f1", &form_card(""), &answer).unwrap();
    assert_eq!(
        reply,
        json!({ "type": "extension_ui_response", "id": "f1", "cancelled": true, "timedOut": true })
    );
}

#[test]
fn only_a_form_cancel_carries_timed_out() {
    let ask = PendingRequest::Question {
        request_id: "q1".into(),
        title: String::new(),
        message: None,
        options: vec![],
        option_details: None,
        input_kind: "text",
        secret: false,
    };
    let answer = json!({ "cancelled": true, "timedOut": true });
    let reply = build_dialog_response("q1", &ask, &answer).unwrap();
    assert_eq!(
        reply,
        json!({ "type": "extension_ui_response", "id": "q1", "cancelled": true })
    );
}

#[test]
fn is_chat_answer_takes_a_boolean_timed_out_only() {
    assert!(is_chat_answer(
        &json!({ "cancelled": true, "timedOut": true })
    ));
    assert!(!is_chat_answer(
        &json!({ "cancelled": true, "timedOut": "yes" })
    ));
}

#[test]
fn a_form_answer_of_another_shape_is_invalid() {
    for answer in [
        json!({ "value": "x" }),
        json!({ "confirmed": true }),
        json!({ "answers": [] }),
        json!({ "cancelled": false }),
        json!({ "data": "x" }),
        json!({ "data": { "a": true } }),
        json!({ "data": { "a": ["x", 1] } }),
        json!({}),
    ] {
        let err = build_dialog_response("f1", &form_card(""), &answer).unwrap_err();
        assert!(err.contains("f1") || err.contains("form"), "{err}");
    }
}

#[test]
fn is_chat_answer_accepts_form_data_and_rejects_malformed_data() {
    assert!(is_chat_answer(&json!({ "data": {} })));
    assert!(is_chat_answer(
        &json!({ "data": { "a": "x", "b": 1, "c": ["y"] } })
    ));
    assert!(!is_chat_answer(&json!({ "data": null })));
    assert!(!is_chat_answer(&json!({ "data": "x" })));
    assert!(!is_chat_answer(&json!({ "data": [] })));
    assert!(!is_chat_answer(&json!({ "data": { "a": false } })));
}
