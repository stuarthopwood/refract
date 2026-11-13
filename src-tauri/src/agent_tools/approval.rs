// Refract-owned approval for mutating panel actions. The card is the existing approval card; its
// request id carries a prefix so `answer_request` completes it here instead of writing to omp.

use serde_json::Value;

use crate::session::agent::PendingRequest;

pub const REQUEST_PREFIX: &str = "refract-tool-";
const OPTIONS: [&str; 2] = ["Approve", "Deny"];

pub fn request_id(call_id: &str) -> String {
    format!("{REQUEST_PREFIX}{call_id}")
}

pub fn is_owned(request_id: &str) -> bool {
    request_id.starts_with(REQUEST_PREFIX)
}

/// Read calls never ask; mutating calls ask unless the working mode is yolo.
pub fn needs_approval(mutates: bool, yolo: bool) -> bool {
    mutates && !yolo
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Approved,
    Denied,
    Cancelled,
}

/// Reads a `chat.answer` payload: `cancelled` wins, then `approve`.
pub fn decision(answer: &Value) -> Decision {
    if answer.get("cancelled").and_then(Value::as_bool) == Some(true) {
        Decision::Cancelled
    } else if answer.get("approve").and_then(Value::as_bool) == Some(true) {
        Decision::Approved
    } else {
        Decision::Denied
    }
}

/// The card text names the panel, action and arguments, so the developer knows what is approved.
pub fn card(call_id: &str, panel_id: &str, action: &str, input: &Value) -> PendingRequest {
    PendingRequest::Approval {
        request_id: request_id(call_id),
        tool: "refract_invoke_panel_action".to_string(),
        target: format!("{panel_id}: {action}"),
        details: vec![format!("Arguments: {}", truncated(input))],
        options: OPTIONS.iter().map(|s| s.to_string()).collect(),
    }
}

/// Card for the session tools; shares the id scheme so `serve` can close it on cancel.
pub fn session_card(
    call_id: &str,
    tool: &str,
    target: String,
    details: Vec<String>,
) -> PendingRequest {
    PendingRequest::Approval {
        request_id: request_id(call_id),
        tool: tool.to_string(),
        target,
        details,
        options: OPTIONS.iter().map(|s| s.to_string()).collect(),
    }
}

const MAX_ARGS_CHARS: usize = 200;

/// A padded path must not push the action off the card.
fn truncated(input: &Value) -> String {
    let text = input.to_string();
    match text.char_indices().nth(MAX_ARGS_CHARS) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn only_mutating_calls_ask_and_yolo_skips() {
        assert!(!needs_approval(false, false));
        assert!(!needs_approval(false, true));
        assert!(needs_approval(true, false));
        assert!(!needs_approval(true, true));
    }

    #[test]
    fn owned_ids_round_trip_the_prefix() {
        let id = request_id("abc");
        assert!(is_owned(&id));
        assert!(!is_owned("abc"));
    }

    #[test]
    fn decision_prefers_cancelled_then_approve() {
        assert_eq!(decision(&json!({ "approve": true })), Decision::Approved);
        assert_eq!(decision(&json!({ "approve": false })), Decision::Denied);
        assert_eq!(decision(&json!({ "cancelled": true })), Decision::Cancelled);
        assert_eq!(
            decision(&json!({ "cancelled": true, "approve": true })),
            Decision::Cancelled
        );
    }

    #[test]
    fn card_names_panel_action_and_arguments() {
        let PendingRequest::Approval {
            request_id,
            target,
            details,
            options,
            ..
        } = card(
            "c1",
            "git-changes",
            "stage_file",
            &json!({ "path": "a.ts" }),
        )
        else {
            panic!("expected an approval card");
        };
        assert_eq!(request_id, "refract-tool-c1");
        assert_eq!(target, "git-changes: stage_file");
        assert!(details[0].contains("a.ts"));
        assert_eq!(options, vec!["Approve", "Deny"]);
    }

    #[test]
    fn session_card_uses_owned_id_and_options() {
        let PendingRequest::Approval {
            request_id,
            tool,
            target,
            details,
            options,
        } = session_card(
            "c2",
            "refract_create_session",
            "repo".into(),
            vec!["d".into()],
        )
        else {
            panic!("expected an approval card");
        };
        assert_eq!(request_id, "refract-tool-c2");
        assert_eq!(tool, "refract_create_session");
        assert_eq!(target, "repo");
        assert_eq!(details, vec!["d"]);
        assert_eq!(options, vec!["Approve", "Deny"]);
    }
}
