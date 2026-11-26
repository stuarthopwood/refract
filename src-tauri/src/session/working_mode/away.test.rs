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
fn the_wider_negative_vocabulary_is_picked() {
    assert_eq!(safe_position(["Approve", "Decline"]), Some(1));
    assert_eq!(safe_position(["Allow", "Not now"]), Some(1));
    assert_eq!(safe_position(["Allow", "Not yet"]), Some(1));
    for word in [
        "Disallow", "Refuse", "Abort", "Never", "Stop", "Dismiss", "Later", "Nope", "None",
    ] {
        assert_eq!(safe_position(["Go", word]), Some(1), "{word}");
    }
    assert_eq!(safe_position(["Go", "Not now."]), Some(1));
}

#[test]
fn a_whole_label_negative_beats_a_longer_phrase_that_starts_with_one() {
    assert_eq!(safe_position(["Skip tests and deploy", "No"]), Some(1));
    assert_eq!(safe_position(["Stop here", "Deny"]), Some(1));
    assert_eq!(safe_position(["Skip tests and deploy", "Deploy"]), Some(0));
    assert_eq!(safe_position(["Deny", "No"]), Some(0));
}

#[test]
fn labels_are_folded_before_matching() {
    assert_eq!(safe_position(["Yes", "\u{ff2e}\u{ff4f}"]), Some(1));
    assert_eq!(safe_position(["Yes", "\u{200b}\u{feff}No"]), Some(1));
    assert_eq!(safe_position(["Yes", "\u{202e}Deny"]), Some(1));
    assert_eq!(safe_position(["Yes", "  NOT   NOW "]), Some(1));
}

#[test]
fn a_word_that_merely_starts_with_a_negative_is_not_one() {
    assert_eq!(safe_position(["Nothing", "Notes"]), Some(0));
    assert_eq!(safe_position(["Nowhere", "Nonetheless"]), Some(0));
    assert_eq!(safe_position(["Noted", "Stopwatch"]), Some(0));
}

#[test]
fn only_one_steer_slot_is_held_at_a_time() {
    let slot = Log::default().steer_slot();
    let mut first = slot.begin(Kind::Answered).expect("the slot is free");
    assert!(slot.begin(Kind::Answered).is_none());
    assert_eq!(first.next(), Some(Kind::Answered));
    assert_eq!(first.next(), None);
    assert!(slot.begin(Kind::Answered).is_some());
}

#[test]
fn the_strongest_pending_kind_is_sent_once_when_the_steer_ends() {
    let slot = Log::default().steer_slot();
    let mut guard = slot.begin(Kind::Answered).expect("the slot is free");
    for kind in [Kind::Cancelled, Kind::Denied, Kind::Answered] {
        assert!(slot.begin(kind).is_none());
    }
    assert_eq!(guard.next(), Some(Kind::Denied));
    assert_eq!(guard.next(), None);
    assert!(slot.begin(Kind::Answered).is_some());
}

#[test]
fn cancelled_outranks_answered_in_the_pending_slot() {
    let slot = Log::default().steer_slot();
    let mut guard = slot.begin(Kind::Answered).expect("the slot is free");
    assert!(slot.begin(Kind::Answered).is_none());
    assert!(slot.begin(Kind::Cancelled).is_none());
    assert!(slot.begin(Kind::Answered).is_none());
    assert_eq!(guard.next(), Some(Kind::Cancelled));
}

#[test]
fn dropping_the_guard_frees_the_slot_and_clears_the_pending_kind() {
    let slot = Log::default().steer_slot();
    let guard = slot.begin(Kind::Answered).expect("the slot is free");
    assert!(slot.begin(Kind::Denied).is_none());
    drop(guard);
    let mut again = slot.begin(Kind::Answered).expect("released on drop");
    assert_eq!(again.next(), None, "the dropped steer left nothing pending");
}

#[test]
fn a_panic_while_holding_the_guard_frees_the_slot() {
    let slot = Log::default().steer_slot();
    let held = Arc::clone(&slot);
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let _guard = held.begin(Kind::Answered).expect("the slot is free");
        panic!("a steer that panics");
    }));
    assert!(outcome.is_err());
    assert!(slot.begin(Kind::Answered).is_some());
}
