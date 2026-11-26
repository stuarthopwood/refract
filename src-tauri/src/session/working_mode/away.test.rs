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

#[test]
fn a_select_picks_the_first_negative_label_else_the_first() {
    assert_eq!(safe_position(["Yes", "No"]), Some(1));
    assert_eq!(
        safe_position(["Approve and execute", "Refine plan"]),
        Some(1)
    );
    assert_eq!(safe_position(["Staging", "Production"]), Some(0));
    assert_eq!(safe_position(["Allow", "DENY it"]), Some(1));
    assert_eq!(safe_position(["Go", "Don\u{2019}t go"]), Some(1));
    assert_eq!(safe_position(["Go", "Do not go"]), Some(1));
    assert_eq!(safe_position(["Go", "Keep both"]), Some(1));
    assert_eq!(safe_position(["Nothing", "Notes"]), Some(0));
    assert_eq!(safe_position(Vec::<&str>::new()), None);
}

fn entry(kind: Kind, question: &str) -> Entry {
    Entry {
        kind,
        question: question.to_string(),
        outcome: "x".to_string(),
    }
}

#[test]
fn the_log_keeps_at_most_the_cap_and_counts_the_rest() {
    let mut log = Log::default();
    for i in 0..LOG_CAP + 7 {
        log.push(entry(Kind::Answered, &format!("q{i}")));
    }
    let (entries, dropped) = log.take();
    assert_eq!(entries.len(), LOG_CAP);
    assert_eq!(dropped, 7);
    let text = summary_text(&entries, dropped);
    assert!(text.starts_with(&format!("While you were away, {} automatic", LOG_CAP + 7)));
    assert!(text.ends_with("- +7 more"));
}

#[test]
fn the_summary_names_answered_and_denied_entries() {
    let entries = [
        entry(Kind::Answered, "Pick"),
        entry(Kind::Denied, "bash ls"),
    ];
    let text = summary_text(&entries, 0);
    assert!(text.contains("- Answered \"Pick\" with x."));
    assert!(text.contains("- Denied approval for \"bash ls\"."));
    assert!(!text.contains("more"));
}

#[test]
fn a_long_title_is_clipped_to_the_text_cap() {
    let clipped = clip(&"é".repeat(TEXT_CAP + 50));
    assert_eq!(clipped.chars().count(), TEXT_CAP + 1);
    assert!(clipped.ends_with('…'));
    assert_eq!(clip("short"), "short");
}

#[test]
fn only_one_steer_is_in_flight_at_a_time() {
    let mut log = Log::default();
    assert!(log.begin_steer());
    assert!(!log.begin_steer());
    log.end_steer();
    assert!(log.begin_steer());
}
