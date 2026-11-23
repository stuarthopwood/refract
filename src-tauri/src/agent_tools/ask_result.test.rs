use super::*;
use crate::agent_tools::ask_schema::AskedOption;

fn option(label: &str, recommended: bool) -> AskedOption {
    AskedOption {
        label: label.to_string(),
        description: None,
        recommended,
        reason: None,
    }
}

fn question(id: &str, text: &str, options: Vec<AskedOption>) -> AskedQuestion {
    AskedQuestion {
        id: id.to_string(),
        question: text.to_string(),
        header: None,
        options,
        multi: false,
    }
}

fn answer(id: &str, selected: &[&str], typed: Option<&str>, notes: &[(&str, &str)]) -> AskAnswer {
    AskAnswer {
        id: id.to_string(),
        selected_options: selected.iter().map(|s| s.to_string()).collect(),
        custom_input: typed.map(str::to_string),
        notes: notes
            .iter()
            .map(|(option, text)| AskNote {
                option: option.to_string(),
                text: text.to_string(),
            })
            .collect(),
        by_away: false,
    }
}

#[test]
fn a_typed_answer_longer_than_a_note_is_never_truncated() {
    let long = "x".repeat(1500);
    let q = question("q1", "Why?", vec![option("A", false)]);
    let text = format_answers(&[q], &[answer("q1", &[], Some(&long), &[])]);
    assert!(text.contains(&format!("Typed: \"{long}\".")));
}

#[test]
fn a_question_longer_than_a_note_is_never_truncated() {
    let long = "q".repeat(1200);
    let q = question("q1", &long, vec![option("A", false)]);
    let text = format_answers(&[q], &[answer("q1", &["A"], None, &[])]);
    assert!(text.contains(&format!("1. {long} Picked:")));
}

#[test]
fn every_field_stays_on_one_line_and_bidi_characters_are_dropped() {
    let q = question(
        "q1",
        "Which\ndatabase?\u{2028}",
        vec![option("Post\u{202E}gres", true)],
    );
    let a = answer(
        "q1",
        &["Post\u{202E}gres"],
        Some("line one\r\nline two\u{0085}end"),
        &[("Post\u{202E}gres", "use v16\nplease")],
    );
    let text = format_answers(&[q], &[a]);
    let lines: Vec<&str> = text.split('\n').collect();
    assert_eq!(
        lines.len(),
        3,
        "header, question line and one note: {text:?}"
    );
    assert!(lines[1].starts_with("1. Which database? "));
    assert!(lines[1].contains("A \"Postgres\" (recommended)"));
    assert!(lines[1].contains("Typed: \"line one  line two end\"."));
    assert_eq!(lines[2], " Note on A: use v16 please.");
    assert!(!text.contains('\u{202E}'));
}

#[test]
fn a_note_on_an_option_the_question_never_offered_names_the_flattened_label() {
    let q = question("q1", "Q?", vec![option("A", false)]);
    let a = answer("q1", &["A"], None, &[("Odd\nlabel", "hi")]);
    let text = format_answers(&[q], &[a]);
    assert!(text.contains("\n Note on \"Odd label\": hi."));
}

#[test]
fn a_note_over_a_thousand_characters_is_never_truncated() {
    let long = "n".repeat(1500);
    let q = question("q1", "Q?", vec![option("A", false)]);
    let text = format_answers(&[q], &[answer("q1", &["A"], None, &[("A", &long)])]);
    assert!(text.contains(&format!("Note on A: {long}.")));
}

#[test]
fn a_label_over_a_thousand_characters_is_never_truncated() {
    let long = "l".repeat(1200);
    let q = question("q1", "Q?", vec![option(&long, false)]);
    let text = format_answers(&[q], &[answer("q1", &[long.as_str()], None, &[])]);
    assert!(text.contains(&format!("\"{long}\"")));
}

#[test]
fn a_question_without_an_answer_reads_as_unanswered() {
    let q = question("q1", "Q?", vec![option("A", false)]);
    assert_eq!(
        format_answers(&[q], &[]),
        "The developer answered 1 question.\n1. Q? No answer."
    );
}

#[test]
fn an_away_mode_answer_is_attributed_in_the_text_and_survives_serialising() {
    let q = question("q1", "Q?", vec![option("A", true)]);
    let mut away = answer("q1", &["A"], None, &[]);
    away.by_away = true;
    let text = format_answers(std::slice::from_ref(&q), std::slice::from_ref(&away));
    assert_eq!(
        text,
        "Away Mode answered 1 question.\n1. Q? Picked: A \"A\" (recommended)."
    );
    assert_eq!(serde_json::to_value(&away).unwrap()["byAway"], true);
    let back: AskAnswer = serde_json::from_value(serde_json::to_value(&away).unwrap()).unwrap();
    assert!(back.by_away);
}

#[test]
fn a_developer_answer_carries_no_away_marker() {
    let q = question("q1", "Q?", vec![option("A", false)]);
    let human = answer("q1", &["A"], None, &[]);
    assert!(format_answers(&[q], std::slice::from_ref(&human)).starts_with("The developer answered"));
    assert!(serde_json::to_value(&human).unwrap().get("byAway").is_none());
}
