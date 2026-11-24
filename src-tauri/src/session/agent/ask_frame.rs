use serde_json::Value;

use super::{AskOption, AskQuestion};

/// `None` when `questions` is missing, empty, or has an entry without an `id` (#572).
pub(super) fn parse_ask_questions(frame: &Value) -> Option<Vec<AskQuestion>> {
    let raw = frame.get("questions")?.as_array()?;
    if raw.is_empty() {
        return None;
    }
    let mut questions = Vec::with_capacity(raw.len());
    for q in raw {
        let qid = q.get("id").and_then(Value::as_str).unwrap_or("");
        if qid.is_empty() {
            return None;
        }
        let options = q
            .get("options")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .map(|o| AskOption {
                        label: o
                            .get("label")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        description: o
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        recommended: false,
                        reason: None,
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        questions.push(AskQuestion {
            id: qid.to_string(),
            question: q
                .get("question")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            header: q.get("header").and_then(Value::as_str).map(str::to_string),
            options,
            multi: q.get("multi").and_then(Value::as_bool).unwrap_or(false),
            recommended: q.get("recommended").and_then(Value::as_i64),
        });
    }
    Some(questions)
}
