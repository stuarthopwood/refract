// Pending-request / dialog machinery (port of `dialogs.ts`): `extension_ui_request` frame
// classification, approval-title parsing, dialog-response building, and `chat.answer`. See
// `mod.rs`'s own header for this module's place in the `agent/` split and the lane extension
// contract.

use serde_json::{json, Value};

use crate::omp::transcript::RequestResolution;

use super::commands::string_array;
use super::launch::truncate;
use super::{AgentError, PendingRequest, SessionAgent, SessionStatus};

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
    Notify { message: String, level: String },
    Request(PendingRequest),
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
            if title.starts_with(APPROVAL_PREFIX) {
                let (tool, details) = parse_approval_title(&title);
                let target = pick_approval_target(&tool, &details);
                return DialogClassification::Request(PendingRequest::Approval {
                    request_id: id,
                    tool,
                    target,
                    details,
                });
            }
            let options = string_array(frame.get("options"));
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

/// Port of `dialogs.ts`'s own `buildDialogResponse`.
fn build_dialog_response(
    request_id: &str,
    request: &PendingRequest,
    answer: &Value,
) -> Result<Value, String> {
    if answer.get("cancelled") == Some(&Value::Bool(true)) {
        return Ok(json!({ "type": "extension_ui_response", "id": request_id, "cancelled": true }));
    }
    if matches!(request, PendingRequest::Approval { .. }) {
        let approve = answer
            .get("approve")
            .and_then(Value::as_bool)
            .ok_or_else(|| {
                format!("expected an approve answer for approval request {request_id}")
            })?;
        return Ok(
            json!({ "type": "extension_ui_response", "id": request_id, "value": if approve { "Approve" } else { "Deny" } }),
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
    matches!(obj.get("approve"), Some(Value::Bool(_)))
        || matches!(obj.get("value"), Some(Value::String(_)))
        || matches!(obj.get("confirmed"), Some(Value::Bool(_)))
        || obj.get("cancelled") == Some(&Value::Bool(true))
}
