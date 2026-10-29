// Pending-request / dialog machinery (port of `dialogs.ts`): `extension_ui_request` frame
// classification, approval-title parsing, dialog-response building, and `chat.answer`. See
// `mod.rs`'s own header for this module's place in the `agent/` split and the lane extension
// contract.

use serde_json::{json, Value};

use crate::omp::transcript::RequestResolution;

use super::commands::string_array;
use super::launch_support::truncate;
use super::{AgentError, AskOption, AskQuestion, PendingRequest, SessionAgent, SessionStatus};

impl SessionAgent {
    /// `chat.answer` (T028): writes the `extension_ui_response` for a still-pending request
    /// (via `OmpProcess::send_raw`, which preserves the ORIGINAL request's own `id` -- see that
    /// method's own doc comment) and marks it resolved.
    pub async fn answer_request(
        &self,
        request_id: String,
        answer: Value,
    ) -> Result<(), AgentError> {
        let (request, proc) = {
            let state = self.state.lock().await;
            let request = state
                .pending
                .iter()
                .find(|r| r.request_id() == request_id)
                .cloned()
                .ok_or_else(|| {
                    AgentError::new(
                        "not-found",
                        format!(
                            "SessionAgent {}: no pending request {request_id}",
                            self.session_id
                        ),
                    )
                })?;
            let proc = state.process.clone().ok_or_else(|| {
                AgentError::new(
                    "agent-not-running",
                    format!(
                        "SessionAgent {}: cannot answer, no live process",
                        self.session_id
                    ),
                )
            })?;
            (request, proc)
        };
        let response = build_dialog_response(&request_id, &request, &answer)
            .map_err(|err| AgentError::new("invalid-argument", err))?;
        proc.send_raw(response)
            .await
            .map_err(|err| AgentError::new("prompt-failed", err.to_string()))?;

        // Port of `SessionAgent.ts` `answer`'s resolved mapping: `cancelled` key wins, then
        // `approve` true/false, otherwise a question answer.
        let resolved = if answer.get("cancelled").is_some() {
            RequestResolution::Cancelled
        } else if let Some(approve) = answer.get("approve") {
            if approve.as_bool() == Some(true) {
                RequestResolution::Approved
            } else {
                RequestResolution::Denied
            }
        } else {
            RequestResolution::Answered
        };
        self.upsert_request_row(&request_id, Some(resolved)).await;
        let became_working = {
            let mut state = self.state.lock().await;
            state.pending.retain(|r| r.request_id() != request_id);
            state.pending.is_empty() && state.status == SessionStatus::NeedsYou
        };
        self.events
            .emit_request_resolved(&self.session_id, &request_id);
        if became_working {
            self.set_status(SessionStatus::Working, None, None).await;
        }
        Ok(())
    }
}

pub(super) enum DialogClassification {
    Ignore,
    Cancel(String),
    Notify {
        message: String,
        level: String,
    },
    Request(PendingRequest),
    /// D3 (#572): an `ask` frame with no/empty `questions`, or any question missing a non-empty
    /// `id`. No `PendingRequest` is ever created for this -- `frame.rs`'s own handler answers
    /// `{cancelled:true}` on the wire itself and surfaces the error notice.
    Malformed {
        id: String,
    },
}

const APPROVAL_PREFIX: &str = "Allow tool:";
const MAX_TARGET_LENGTH: usize = 200;

/// Port of `dialogs.ts`'s own `parseApprovalTitle`. Only called once the caller has already
/// confirmed `title.starts_with(APPROVAL_PREFIX)`, so the first line always carries the prefix.
fn parse_approval_title(title: &str) -> (String, Vec<String>) {
    let first_line = title.split('\n').next().unwrap_or("");
    let tool = first_line
        .strip_prefix(APPROVAL_PREFIX)
        .unwrap_or(first_line)
        .trim()
        .to_string();
    let details: Vec<String> = title
        .split('\n')
        .skip(1)
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    (tool, details)
}

fn pick_approval_target(tool: &str, details: &[String]) -> String {
    const LABELS: &[&str] = &["Path:", "File:", "Command:"];
    if let Some(first) = details.first() {
        for label in LABELS {
            if first.len() >= label.len() && first[..label.len()].eq_ignore_ascii_case(label) {
                return truncate(first[label.len()..].trim(), MAX_TARGET_LENGTH);
            }
        }
    }
    truncate(tool, MAX_TARGET_LENGTH)
}

/// Port of `dialogs.ts`'s own `classifyDialog`.
pub(super) fn classify_dialog(frame: &Value) -> DialogClassification {
    let method = frame.get("method").and_then(Value::as_str).unwrap_or("");
    let id = frame
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    match method {
        "select" => {
            let title = frame
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let options = string_array(frame.get("options"));
            if title.starts_with(APPROVAL_PREFIX) {
                let (tool, details) = parse_approval_title(&title);
                let target = pick_approval_target(&tool, &details);
                return DialogClassification::Request(PendingRequest::Approval {
                    request_id: id,
                    tool,
                    target,
                    details,
                    options,
                });
            }
            let option_details = frame
                .get("optionDetails")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .map(|d| {
                            d.get("description")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        })
                        .collect::<Vec<_>>()
                });
            DialogClassification::Request(PendingRequest::Question {
                request_id: id,
                title,
                message: None,
                options,
                option_details,
                input_kind: "choice",
            })
        }
        "input" | "editor" => DialogClassification::Request(PendingRequest::Question {
            request_id: id,
            title: frame
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            message: None,
            options: vec![],
            option_details: None,
            input_kind: "text",
        }),
        "confirm" => DialogClassification::Request(PendingRequest::Question {
            request_id: id,
            title: frame
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            message: frame
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string),
            options: vec!["Yes".to_string(), "No".to_string()],
            option_details: None,
            input_kind: "confirm",
        }),
        "ask" => match parse_ask_questions(frame) {
            Some(questions) => DialogClassification::Request(PendingRequest::Ask {
                request_id: id,
                questions,
                // Gate-fix (round 1, security/code review HIGH): OMP's `timeout` is
                // milliseconds, not seconds -- `ask.md` step 3 ("reads `ask.timeout`, converts
                // seconds to milliseconds" before opening the dialog) and `rpc.md`'s own example
                // (`"timeout": 30000`) both confirm the WIRE value is already in ms. The earlier
                // `(secs * 1000.0)` conversion made every deadline about 1000x too late.
                deadline_at: frame
                    .get("timeout")
                    .and_then(Value::as_f64)
                    .filter(|ms| ms.is_finite() && *ms >= 0.0)
                    .map(|ms| now_ms().saturating_add(ms as i64)),
            }),
            None => DialogClassification::Malformed { id },
        },
        "cancel" => DialogClassification::Cancel(
            frame
                .get("targetId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or(id),
        ),
        "notify" => DialogClassification::Notify {
            message: frame
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            level: frame
                .get("notifyType")
                .and_then(Value::as_str)
                .unwrap_or("info")
                .to_string(),
        },
        _ => DialogClassification::Ignore,
    }
}

/// Port of `dialogs.ts`'s own `ask` question parsing (D3, #572): `None` when the frame has no
/// (or an empty) `questions` array, or when any question is missing a non-empty `id` --
/// both map to `DialogClassification::Malformed` at the call site, never a partially-built
/// `PendingRequest::Ask`.
fn parse_ask_questions(frame: &Value) -> Option<Vec<AskQuestion>> {
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
        // `preview` (rich-dialog-only, D3) is intentionally never read here.
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

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Defence in depth (gate-fix, security/code review Medium): the renderer already only ever
/// builds `answers` from the labels it rendered and never sends both an option and `customInput`
/// for a single choice, and OMP itself fails closed on a malformed `answers` shape -- but nothing
/// in between checked it before this. Rejects a wrong count or order, an id that does not match
/// the pending `PendingRequest::Ask`'s own question at that position, a label never offered, a
/// multi-select count violation on a single-choice question, an overlong `customInput`, or both
/// an option and `customInput` sent together for a single choice.
const MAX_ASK_CUSTOM_INPUT_LEN: usize = 4096;

fn validate_ask_answers(questions: &[AskQuestion], answers: &[Value]) -> Result<(), String> {
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

/// #1140/#496: OMP (18.12.5 to 18.13.3, read from the compiled binary) builds an approval
/// `select`'s options as `[...grant labels, ...always-grant labels, plain approve, session item?,
/// deny]` and maps any label it does not recognise to deny. The plain approve option ("Approve",
/// or "Approve Once" when grants exist) is found by position, never by guessing its text.
fn plain_approve_label(options: &[String]) -> Option<&str> {
    let n = options.len();
    if n < 2 {
        return None;
    }
    let has_session = n >= 3 && options[n - 2].ends_with(" for this session");
    let index = if has_session { n - 3 } else { n - 2 };
    Some(options[index].as_str())
}

/// The exact label to answer an approval with: the renderer's chosen `option` (which must be one
/// the request offered and agree with `approve`), else the plain approve or the deny option.
fn approval_answer_label(
    options: &[String],
    approve: bool,
    chosen: Option<&str>,
) -> Result<String, String> {
    if options.is_empty() {
        // A frame that carried no options at all: OMP's own fixed pair is all that can match.
        return match chosen {
            None => Ok(if approve { "Approve" } else { "Deny" }.to_string()),
            Some(label) => Err(format!("option not offered: {label}")),
        };
    }
    let deny = options[options.len() - 1].as_str();
    if let Some(label) = chosen {
        if !options.iter().any(|o| o == label) {
            return Err(format!("option not offered: {label}"));
        }
        if (label == deny) == approve {
            return Err(format!("option {label} does not match approve={approve}"));
        }
        return Ok(label.to_string());
    }
    if !approve {
        return Ok(deny.to_string());
    }
    plain_approve_label(options)
        .map(str::to_string)
        .ok_or_else(|| "no approve option offered".to_string())
}

/// Port of `dialogs.ts`'s own `buildDialogResponse`.
fn build_dialog_response(
    request_id: &str,
    request: &PendingRequest,
    answer: &Value,
) -> Result<Value, String> {
    if answer.get("cancelled") == Some(&Value::Bool(true)) {
        return Ok(json!({ "type": "extension_ui_response", "id": request_id, "cancelled": true }));
    }
    if let PendingRequest::Approval { options, .. } = request {
        let approve = answer
            .get("approve")
            .and_then(Value::as_bool)
            .ok_or_else(|| {
                format!("expected an approve answer for approval request {request_id}")
            })?;
        let chosen = answer.get("option").and_then(Value::as_str);
        let label = approval_answer_label(options, approve, chosen)
            .map_err(|err| format!("{err} (approval request {request_id})"))?;
        return Ok(json!({ "type": "extension_ui_response", "id": request_id, "value": label }));
    }
    if let PendingRequest::Ask { questions, .. } = request {
        let answers = answer
            .get("answers")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("expected an answers array for ask request {request_id}"))?;
        validate_ask_answers(questions, answers)?;
        return Ok(
            json!({ "type": "extension_ui_response", "id": request_id, "answers": answers.clone() }),
        );
    }
    if let PendingRequest::Question { input_kind, .. } = request {
        if *input_kind == "confirm" {
            if let Some(value) = answer.get("value").and_then(Value::as_str) {
                return Ok(
                    json!({ "type": "extension_ui_response", "id": request_id, "confirmed": value == "Yes" }),
                );
            }
        }
    }
    if let Some(confirmed) = answer.get("confirmed").and_then(Value::as_bool) {
        return Ok(
            json!({ "type": "extension_ui_response", "id": request_id, "confirmed": confirmed }),
        );
    }
    if let Some(value) = answer.get("value").and_then(Value::as_str) {
        return Ok(json!({ "type": "extension_ui_response", "id": request_id, "value": value }));
    }
    Err(format!(
        "unsupported dialog answer for request {request_id}"
    ))
}

/// `chat.answer`'s own wire-shape validation (port of `chat.ts`'s own `isChatAnswer`).
pub fn is_chat_answer(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    (matches!(obj.get("approve"), Some(Value::Bool(_)))
        && obj.get("option").map_or(true, Value::is_string))
        || matches!(obj.get("value"), Some(Value::String(_)))
        || matches!(obj.get("confirmed"), Some(Value::Bool(_)))
        || obj.get("cancelled") == Some(&Value::Bool(true))
        || matches!(obj.get("answers"), Some(Value::Array(_)))
}

#[cfg(test)]
#[path = "requests.test.rs"]
mod tests;
