use super::*;

fn call(label: &str) -> Value {
    json!({ "questions": [{ "id": "q1", "question": "Pick?", "options": [{ "label": label }, { "label": "Other" }] }] })
}

#[test]
fn a_single_line_label_is_accepted() {
    assert!(parse(&call("Postgres")).is_ok());
}

#[test]
fn zero_width_joiner_non_joiner_and_emoji_selector_in_a_label_are_accepted() {
    for label in [
        "Team \u{1F468}\u{200D}\u{1F4BB}",
        "\u{0645}\u{200C}\u{0647}",
        "Heart \u{2764}\u{FE0F}",
    ] {
        assert!(parse(&call(label)).is_ok(), "label {label:?}");
    }
}

#[test]
fn a_label_with_a_line_break_or_control_character_is_rejected_as_invalid_input() {
    for label in [
        "One\ntwo",
        "One\rtwo",
        "One\u{2028}two",
        "One\u{2029}two",
        "One\u{0007}two",
        "One\u{202E}two",
        "One\u{200B}two",
        "One\u{2060}two",
    ] {
        let err = parse(&call(label)).unwrap_err();
        assert_eq!(err.code, INVALID_INPUT, "label {label:?}");
        assert!(
            err.message.contains("single line of plain text"),
            "{}",
            err.message
        );
    }
}

#[test]
fn the_card_key_is_the_one_given_and_the_card_has_no_deadline() {
    let questions = parse(&call("Postgres")).unwrap();
    match card("call-1", &questions) {
        PendingRequest::Ask {
            request_id,
            deadline_at,
            host_call,
            ..
        } => {
            assert_eq!(request_id, "call-1");
            assert!(deadline_at.is_none());
            assert!(host_call);
        }
        other => panic!("expected an ask card, got {other:?}"),
    }
}
