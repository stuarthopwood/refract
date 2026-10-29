// Issue #1284 (spec 040 FR-001): an assistant message OMP ended with `stopReason: "error"`
// carries the provider's own `errorMessage`; that becomes the `turn-error` row at the end of the
// turn. The text is agent/provider-authored and untrusted: bounded here, rendered as plain text.
use std::sync::Arc;

use serde_json::Value;

use super::TranscriptItem;

const MAX_ERROR_CHARS: usize = 2000;
const FALLBACK_TEXT: &str = "The model returned an error.";

/// The `turn-error` item for a settled assistant `message`, or `None` for any other message.
pub(super) fn build_turn_error_item(message_id: &str, message: &Value) -> Option<TranscriptItem> {
    if message.get("stopReason").and_then(Value::as_str) != Some("error") {
        return None;
    }
    let text = message
        .get("errorMessage")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or(FALLBACK_TEXT);
    Some(TranscriptItem::TurnError {
        id: format!("{message_id}:error"),
        text: text.chars().take(MAX_ERROR_CHARS).collect(),
    })
}

/// `true` when the current turn (the items after the last user message) already has a
/// `turn-error` row, so a following `prompt_result` error does not add a second row.
pub(super) fn current_turn_has_error(items: &[Arc<TranscriptItem>]) -> bool {
    items
        .iter()
        .rev()
        .take_while(|item| !matches!(item.as_ref(), TranscriptItem::User { .. }))
        .any(|item| matches!(item.as_ref(), TranscriptItem::TurnError { .. }))
}
