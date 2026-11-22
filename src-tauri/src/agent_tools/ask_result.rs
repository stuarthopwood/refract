// The text a `refract_ask` call returns to the agent: numbered plain text, one line per question
// and an optional note line under it, so the model can read it without a parser.

use serde::Deserialize;

use super::ask_schema::AskedQuestion;

pub(crate) const MAX_NOTE_CHARS: usize = 1000;
pub(crate) const CANCELLED: &str = "The developer cancelled the questions.";

/// A developer's note on one picked option.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct AskNote {
    pub option: String,
    pub text: String,
}

/// One question's answer, as the `chat.answer` payload carries it.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AskAnswer {
    pub id: String,
    pub selected_options: Vec<String>,
    pub custom_input: Option<String>,
    pub notes: Vec<AskNote>,
}

/// A, B, ... Z, then AA, AB, ... for the rare question with more than 26 options.
fn letter(index: usize) -> String {
    let mut n = index + 1;
    let mut out = Vec::new();
    while n > 0 {
        n -= 1;
        out.push(b'A' + (n % 26) as u8);
        n /= 26;
    }
    out.reverse();
    String::from_utf8_lossy(&out).into_owned()
}

fn flatten(text: &str) -> String {
    text.replace("\r\n", " ")
        .replace(['\n', '\r'], " ")
        .chars()
        .take(MAX_NOTE_CHARS)
        .collect()
}

fn picked(question: &AskedQuestion, answer: &AskAnswer) -> Option<String> {
    let picks: Vec<String> = answer
        .selected_options
        .iter()
        .map(|label| {
            let found = question.options.iter().position(|o| &o.label == label);
            let marker = match found {
                Some(i) if question.options[i].recommended => " (recommended)",
                _ => "",
            };
            match found {
                Some(i) => format!("{} \"{label}\"{marker}", letter(i)),
                None => format!("\"{label}\""),
            }
        })
        .collect();
    (!picks.is_empty()).then(|| format!("Picked: {}", picks.join(", ")))
}

fn typed(answer: &AskAnswer) -> Option<String> {
    answer
        .custom_input
        .as_deref()
        .filter(|text| !text.trim().is_empty())
        .map(|text| format!("Typed: \"{text}\""))
}

fn question_lines(number: usize, question: &AskedQuestion, answer: &AskAnswer) -> String {
    let parts: Vec<String> = [picked(question, answer), typed(answer)]
        .into_iter()
        .flatten()
        .collect();
    let outcome = if parts.is_empty() {
        "No answer".to_string()
    } else {
        parts.join(". ")
    };
    let mut out = format!("{number}. {} {outcome}.", question.question);
    for note in &answer.notes {
        let target = match question.options.iter().position(|o| o.label == note.option) {
            Some(i) => letter(i),
            None => format!("\"{}\"", note.option),
        };
        out.push_str(&format!("\n Note on {target}: {}.", flatten(&note.text)));
    }
    out
}

/// The result for a submitted card; a question with no matching answer reads as unanswered.
pub(crate) fn format_answers(questions: &[AskedQuestion], answers: &[AskAnswer]) -> String {
    let count = questions.len();
    let noun = if count == 1 { "question" } else { "questions" };
    let blank = AskAnswer::default();
    let mut out = format!("The developer answered {count} {noun}.");
    for (index, question) in questions.iter().enumerate() {
        let answer = answers
            .iter()
            .find(|a| a.id == question.id)
            .unwrap_or(&blank);
        out.push('\n');
        out.push_str(&question_lines(index + 1, question, answer));
    }
    out
}
