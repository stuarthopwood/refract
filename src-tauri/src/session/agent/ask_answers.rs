// Validation of the answers to a host-call `refract_ask` card before they reach the waiting tool.

use serde_json::Value;

use crate::agent_tools::ask_result::AskAnswer;

use super::AskQuestion;

/// The reply for a host-call card: `None` for the developer's cancel, else the validated answers.
/// `by_away` comes from the caller, never from the JSON, so no payload can claim it.
pub(super) fn host_ask_reply(
    questions: &[AskQuestion],
    answer: &Value,
    by_away: bool,
) -> Result<Option<Vec<AskAnswer>>, String> {
    if answer.get("cancelled") == Some(&Value::Bool(true)) {
        return Ok(None);
    }
    let answers = answer
        .get("answers")
        .and_then(Value::as_array)
        .ok_or_else(|| "expected an answers array for the ask request".to_string())?;
    validate_ask_answers(questions, answers)?;
    let mut replies: Vec<AskAnswer> = serde_json::from_value(Value::Array(answers.clone()))
        .map_err(|err| format!("malformed answers: {err}"))?;
    for reply in &mut replies {
        reply.by_away = by_away;
    }
    Ok(Some(replies))
}

const MAX_NOTE_CHARS: usize = 1000;

/// Each note names an offered option that is also picked, in at most `MAX_NOTE_CHARS` characters.
fn validate_notes(
    question: &AskQuestion,
    selected: &[Value],
    notes: Option<&Value>,
) -> Result<(), String> {
    let Some(notes) = notes else {
        return Ok(());
    };
    let id = &question.id;
    let notes = notes
        .as_array()
        .ok_or_else(|| format!("answer {id} has a non-array notes"))?;
    for note in notes {
        let option = note
            .get("option")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("answer {id} has a note without an option"))?;
        let text = note
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("answer {id} has a note without text"))?;
        if !question.options.iter().any(|o| o.label == option) {
            return Err(format!(
                "answer {id} has a note on an option not offered: {option}"
            ));
        }
        if !selected.iter().any(|label| label.as_str() == Some(option)) {
            return Err(format!(
                "answer {id} has a note on an option not picked: {option}"
            ));
        }
        if text.chars().count() > MAX_NOTE_CHARS {
            return Err(format!(
                "answer {id} has a note over {MAX_NOTE_CHARS} characters"
            ));
        }
    }
    Ok(())
}

/// Rejects answers that do not match the pending question: wrong count, order, or label.
const MAX_ASK_CUSTOM_INPUT_LEN: usize = 4096;

pub(super) fn validate_ask_answers(
    questions: &[AskQuestion],
    answers: &[Value],
) -> Result<(), String> {
    if answers.len() != questions.len() {
        return Err(format!(
            "expected {} answers, got {}",
            questions.len(),
            answers.len()
        ));
    }
    for (question, answer) in questions.iter().zip(answers) {
        let obj = answer
            .as_object()
            .ok_or_else(|| "answer entry is not an object".to_string())?;
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "answer entry has no id".to_string())?;
        if id != question.id {
            return Err(format!(
                "answer id {id} does not match expected {}",
                question.id
            ));
        }
        let selected = obj
            .get("selectedOptions")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("answer {id} has no selectedOptions array"))?;
        let mut selected_count = 0usize;
        for label in selected {
            let label = label
                .as_str()
                .ok_or_else(|| format!("answer {id} has a non-string selectedOptions entry"))?;
            if !question.options.iter().any(|o| o.label == label) {
                return Err(format!(
                    "answer {id} selected an option not offered: {label}"
                ));
            }
            selected_count += 1;
        }
        if !question.multi && selected_count > 1 {
            return Err(format!(
                "answer {id} is single-choice but selected {selected_count} options"
            ));
        }
        validate_notes(question, selected, obj.get("notes"))?;
        match obj.get("customInput") {
            None => {}
            Some(Value::String(text)) => {
                if text.chars().count() > MAX_ASK_CUSTOM_INPUT_LEN {
                    return Err(format!(
                        "answer {id} customInput exceeds {MAX_ASK_CUSTOM_INPUT_LEN} characters"
                    ));
                }
                if !question.multi && selected_count > 0 {
                    return Err(format!(
                        "answer {id} is single-choice but sent both an option and customInput"
                    ));
                }
            }
            Some(_) => return Err(format!("answer {id} has a non-string customInput")),
        }
    }
    Ok(())
}
