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

fn question_with(options: Value, multi: bool) -> Value {
    json!({ "questions": [{ "id": "q1", "question": "Pick?", "multi": multi, "options": options }] })
}

#[test]
fn a_reason_on_a_recommended_option_is_accepted_and_reaches_the_card() {
    let args = question_with(
        json!([{ "label": "A", "recommended": true, "reason": "Fastest to ship" }, { "label": "B" }]),
        false,
    );
    let questions = parse(&args).unwrap();
    match card("call-1", &questions) {
        PendingRequest::Ask { questions, .. } => {
            assert_eq!(
                questions[0].options[0].reason.as_deref(),
                Some("Fastest to ship")
            );
            assert!(questions[0].options[0].recommended);
        }
        other => panic!("expected an ask card, got {other:?}"),
    }
}

#[test]
fn a_reason_on_an_option_that_is_not_recommended_is_invalid_input_naming_question_and_option() {
    for options in [
        json!([{ "label": "A", "recommended": true }, { "label": "B", "reason": "Cheaper" }]),
        json!([{ "label": "A", "recommended": false, "reason": "Cheaper" }]),
    ] {
        let err = parse(&question_with(options, false)).unwrap_err();
        assert_eq!(err.code, INVALID_INPUT);
        assert!(err.message.contains("question \"q1\""), "{}", err.message);
        assert!(
            err.message.contains("belongs only to a recommended option"),
            "{}",
            err.message
        );
    }
}

#[test]
fn the_unrecommended_option_with_a_reason_is_the_one_named() {
    let args = question_with(
        json!([{ "label": "A" }, { "label": "B", "reason": "Cheaper" }]),
        true,
    );
    let err = parse(&args).unwrap_err();
    assert!(err.message.contains("option \"B\""), "{}", err.message);
}

#[test]
fn a_multiple_choice_question_may_recommend_several_options_each_with_a_reason() {
    let args = question_with(
        json!([
            { "label": "A", "recommended": true, "reason": "Cheap" },
            { "label": "B", "recommended": true, "reason": "Quick" },
            { "label": "C" }
        ]),
        true,
    );
    assert!(parse(&args).is_ok());
}

#[test]
fn a_reason_with_a_line_break_control_invisible_or_direction_character_is_invalid_input() {
    for reason in [
        "Fast\nand cheap",
        "Fast\rand cheap",
        "Fast\u{2028}and cheap",
        "Fast\u{2029}and cheap",
        "Fast\u{0007}and cheap",
        "Fast\u{202E}and cheap",
        "Fast\u{200B}and cheap",
    ] {
        let args = question_with(
            json!([{ "label": "A", "recommended": true, "reason": reason }]),
            false,
        );
        let err = parse(&args).unwrap_err();
        assert_eq!(err.code, INVALID_INPUT, "reason {reason:?}");
        assert!(
            err.message.contains("single line of plain text"),
            "{}",
            err.message
        );
    }
}

#[test]
fn a_plain_reason_with_punctuation_and_an_emoji_is_accepted() {
    let args = question_with(
        json!([{ "label": "A", "recommended": true, "reason": "Cheaper, and it ships today \u{1F468}\u{200D}\u{1F4BB}" }]),
        false,
    );
    assert!(parse(&args).is_ok());
}

#[test]
fn the_tool_description_says_a_reason_belongs_to_a_recommended_option() {
    assert!(description().contains("only accepted on a recommended option"));
}
