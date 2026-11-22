// `refract_ask`: name, description, parameter schema and input check; the shape is native `ask`'s
// plus per-option `recommended` and `reason`, all checked here so a bad call fails fixably.

use serde::Deserialize;
use serde_json::{json, Value};

use super::router::{ToolError, INVALID_INPUT};
use crate::session::agent::{AskOption, AskQuestion, PendingRequest};

pub const ASK: &str = "refract_ask";
pub(crate) const MAX_REASON_CHARS: usize = 200;

/// One option of a question; `reason` is the agent's one line on why it recommends the option.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AskedOption {
    pub label: String,
    pub description: Option<String>,
    #[serde(default)]
    pub recommended: bool,
    pub reason: Option<String>,
}

/// One validated question of a `refract_ask` call.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AskedQuestion {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub question: String,
    pub header: Option<String>,
    #[serde(default)]
    pub options: Vec<AskedOption>,
    #[serde(default)]
    pub multi: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AskInput {
    #[serde(default)]
    questions: Vec<AskedQuestion>,
}

pub fn description() -> &'static str {
    "Ask the developer one or more questions and wait for their answers; there is no time limit. \
Use it when you need a decision only they can make. Give each question a unique `id`, the \
`question` text and its `options`; set `multi` to let them pick several. The developer can also \
type their own answer. Mark the option you would choose with `recommended: true` and say why in \
`reason`, one line of at most 200 characters; a single-choice question takes at most one \
recommended option. The result lists each question with what the developer picked or typed, and \
any note they added to an option. If they cancel, you are told so; carry on without the answers."
}

fn option() -> Value {
    json!({
        "type": "object",
        "properties": {
            "label": { "type": "string", "description": "Short choice text." },
            "description": { "type": "string", "description": "Optional detail shown under the label." },
            "recommended": { "type": "boolean", "description": "This is the option you recommend." },
            "reason": { "type": "string", "maxLength": MAX_REASON_CHARS, "description": "Why you recommend it: one line, at most 200 characters." }
        },
        "required": ["label"],
        "additionalProperties": false
    })
}

fn question() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": { "type": "string", "description": "Unique within this call; names the question in the result." },
            "question": { "type": "string", "description": "The question text." },
            "header": { "type": "string", "description": "Optional short heading." },
            "options": { "type": "array", "minItems": 1, "items": option(), "description": "The choices." },
            "multi": { "type": "boolean", "description": "The developer may pick several options. Default false." }
        },
        "required": ["id", "question", "options"],
        "additionalProperties": false
    })
}

pub fn parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "questions": { "type": "array", "minItems": 1, "items": question(), "description": "The questions, asked together." }
        },
        "required": ["questions"],
        "additionalProperties": false
    })
}

fn invalid(message: impl Into<String>) -> ToolError {
    ToolError::new(INVALID_INPUT, message)
}

/// The questions of a call, or the first rule it breaks, worded for the model to correct.
pub(crate) fn parse(args: &Value) -> Result<Vec<AskedQuestion>, ToolError> {
    let input = AskInput::deserialize(args)
        .map_err(|err| invalid(format!("refract_ask arguments are malformed: {err}")))?;
    if input.questions.is_empty() {
        return Err(invalid("questions must hold at least one question"));
    }
    for (index, question) in input.questions.iter().enumerate() {
        check_question(&input.questions[..index], index, question)?;
    }
    Ok(input.questions)
}

fn check_question(
    earlier: &[AskedQuestion],
    index: usize,
    question: &AskedQuestion,
) -> Result<(), ToolError> {
    let id = question.id.trim();
    if id.is_empty() {
        return Err(invalid(format!(
            "question {} has no id; give every question a unique, non-empty id",
            index + 1
        )));
    }
    if let Some(first) = earlier.iter().position(|q| q.id == question.id) {
        return Err(invalid(format!(
            "question {} repeats the id \"{id}\" of question {}; ids must be unique",
            index + 1,
            first + 1
        )));
    }
    let name = format!("question \"{id}\"");
    if question.question.trim().is_empty() {
        return Err(invalid(format!("{name} has no question text")));
    }
    if question.options.is_empty() {
        return Err(invalid(format!(
            "{name} has no options; give it at least one option"
        )));
    }
    check_options(&name, question)
}

fn check_options(name: &str, question: &AskedQuestion) -> Result<(), ToolError> {
    for (index, option) in question.options.iter().enumerate() {
        if option.label.trim().is_empty() {
            return Err(invalid(format!(
                "option {} of {name} has no label",
                index + 1
            )));
        }
        if option.label.contains(|c: char| {
            c.is_control()
                || matches!(c, '\u{2028}' | '\u{2029}')
                || (c != '\u{200D}' && crate::github::profile::is_invisible_format(c))
        }) {
            return Err(invalid(format!(
                "option {} of {name} has a label with a line break or control character; \
labels must be a single line of plain text",
                index + 1
            )));
        }
        if question.options[..index]
            .iter()
            .any(|o| o.label == option.label)
        {
            return Err(invalid(format!(
                "{name} repeats the option label \"{}\"; labels must be unique within a question",
                option.label
            )));
        }
        if let Some(reason) = &option.reason {
            if reason.contains(['\n', '\r']) {
                return Err(invalid(format!(
                    "the reason for option \"{}\" of {name} must be a single line without line breaks",
                    option.label
                )));
            }
            let length = reason.chars().count();
            if length > MAX_REASON_CHARS {
                return Err(invalid(format!(
                    "the reason for option \"{}\" of {name} is {length} characters; keep it to {MAX_REASON_CHARS} or fewer",
                    option.label
                )));
            }
        }
    }
    let recommended = question.options.iter().filter(|o| o.recommended).count();
    if !question.multi && recommended > 1 {
        return Err(invalid(format!(
            "{name} is single-choice but marks {recommended} options recommended; recommend at most one, or set multi to true"
        )));
    }
    Ok(())
}

/// The Question card for a call: keyed by `card_id`, with no deadline, since the card waits for
/// the developer alone.
pub(crate) fn card(card_id: &str, questions: &[AskedQuestion]) -> PendingRequest {
    PendingRequest::Ask {
        request_id: card_id.to_string(),
        questions: questions
            .iter()
            .map(|question| AskQuestion {
                id: question.id.clone(),
                question: question.question.clone(),
                header: question.header.clone(),
                options: question
                    .options
                    .iter()
                    .map(|option| AskOption {
                        label: option.label.clone(),
                        description: option.description.clone(),
                        recommended: option.recommended,
                        reason: option.reason.clone(),
                    })
                    .collect(),
                multi: question.multi,
                recommended: question
                    .options
                    .iter()
                    .position(|option| option.recommended)
                    .and_then(|index| i64::try_from(index).ok()),
            })
            .collect(),
        deadline_at: None,
        host_call: true,
    }
}

#[cfg(test)]
#[path = "ask_schema.test.rs"]
mod tests;
