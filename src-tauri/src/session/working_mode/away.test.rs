use super::*;
use crate::session::agent::AskOption;

fn option(label: &str, recommended: bool) -> AskOption {
    AskOption {
        label: label.to_string(),
        description: None,
        recommended,
        reason: None,
    }
}

fn question(multi: bool, options: Vec<AskOption>, recommended: Option<i64>) -> AskQuestion {
    AskQuestion {
        id: "q1".to_string(),
        question: "Pick?".to_string(),
        header: None,
        options,
        multi,
        recommended,
    }
}

#[test]
fn a_multi_select_takes_every_recommended_option() {
    let q = question(
        true,
        vec![option("A", true), option("B", false), option("C", true)],
        Some(0),
    );
    let answers = ask_answers(&[q]);
    assert_eq!(answers[0]["selectedOptions"], json!(["A", "C"]));
}

#[test]
fn a_single_choice_takes_the_question_level_pick_only() {
    let q = question(false, vec![option("A", true), option("B", true)], Some(0));
    let answers = ask_answers(&[q]);
    assert_eq!(answers[0]["selectedOptions"], json!(["A"]));
}

#[test]
fn a_multi_select_without_flags_falls_back_to_the_question_level_index() {
    let q = question(true, vec![option("A", false), option("B", false)], Some(1));
    let answers = ask_answers(&[q]);
    assert_eq!(answers[0]["selectedOptions"], json!(["B"]));
}

#[test]
fn nothing_recommended_leaves_the_choice_to_the_agent() {
    let q = question(true, vec![option("A", false)], None);
    let answers = ask_answers(&[q]);
    assert_eq!(answers[0]["selectedOptions"], json!([]));
    assert_eq!(answers[0]["customInput"], json!(ASK_FALLBACK));
}

#[test]
fn the_away_summary_names_every_option_picked() {
    let q = question(true, vec![option("A", true), option("B", true)], None);
    let answers = ask_answers(std::slice::from_ref(&q));
    let (asked, chosen) = describe_ask(&[q], &answers);
    assert_eq!(asked, "Pick?");
    assert_eq!(chosen, "A + B");
}
