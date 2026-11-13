// Refract-owned approval for mutating panel actions. The card is the existing approval card; its
// request id carries a prefix so `answer_request` completes it here instead of writing to omp.

use serde_json::Value;

use crate::github::profile::is_invisible_format;
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

/// Card for the session tools; shares the id scheme so `serve` can close it on cancel. Every line
/// is clipped, because an agent-chosen name must not push the action off the card.
pub fn session_card(
    call_id: &str,
    tool: &str,
    target: String,
    details: Vec<String>,
) -> PendingRequest {
    PendingRequest::Approval {
        request_id: request_id(call_id),
        tool: tool.to_string(),
        target: clip_line(&target),
        details: details.iter().map(|d| clip_line(d)).collect(),
        options: OPTIONS.iter().map(|s| s.to_string()).collect(),
    }
}

/// Card text on one line: invisible format and bidi characters (the shared list, so a name cannot
/// reorder or hide card text) are dropped, and line breaks, including U+2028 and U+2029, and other
/// control characters become spaces. U+200D stays so emoji sequences in a name survive.
pub fn flatten(text: &str) -> String {
    text.chars()
        .filter(|c| *c == '\u{200D}' || !is_invisible_format(*c))
        .map(|c| {
            if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') {
                ' '
            } else {
                c
            }
        })
        .collect()
}

/// One card line: flattened, then capped.
pub fn clip_line(text: &str) -> String {
    let flat = flatten(text);
    match flat.char_indices().nth(MAX_ARGS_CHARS) {
        Some((end, _)) => format!("{}…", &flat[..end]),
        None => flat,
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

    #[test]
    fn session_card_lines_are_single_line_and_capped() {
        let padded = format!("a\nb{}", "x".repeat(500));
        let PendingRequest::Approval {
            target, details, ..
        } = session_card("c3", "t", padded.clone(), vec![padded])
        else {
            panic!("expected an approval card");
        };
        for line in [&target, &details[0]] {
            assert!(!line.contains('\n'));
            assert_eq!(line.chars().count(), MAX_ARGS_CHARS + 1);
            assert!(line.starts_with("a b"));
        }
    }

    #[test]
    fn session_card_lines_lose_bidi_and_zero_width_characters() {
        let hidden = "a\u{202A}b\u{202E}c\u{2066}d\u{2069}e\u{200B}f\u{200F}g\u{FEFF}h\u{061C}i";
        let PendingRequest::Approval {
            target, details, ..
        } = session_card("c4", "t", hidden.into(), vec![hidden.into()])
        else {
            panic!("expected an approval card");
        };
        assert_eq!(target, "abcdefghi");
        assert_eq!(details[0], "abcdefghi");
    }

    #[test]
    fn session_card_lines_turn_unicode_line_separators_into_spaces_and_keep_joiners() {
        assert_eq!(flatten("a\u{2028}b\u{2029}c"), "a b c");
        assert_eq!(
            flatten("\u{1F469}\u{200D}\u{1F4BB}"),
            "\u{1F469}\u{200D}\u{1F4BB}"
        );
    }
}
