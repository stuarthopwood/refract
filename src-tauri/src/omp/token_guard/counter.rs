// Model-call counter per Conversation (#1212, spec 021 FR-013): one call is one completed
// assistant `message_end`. Pure logic and state; `session::token_guard` drives it from frames.

use serde_json::Value;

/// Calls at which the Status line shows "Long conversation" with a Hand off button.
pub const LONG_CONVERSATION_CALLS: u32 = 300;

#[derive(Default)]
pub struct CallCounter {
    /// Bumped on every Conversation change; the renderer resets its once-only announcements on it.
    pub conversation: u64,
    pub calls: u32,
    capturing: bool,
    captured: Option<String>,
}

impl CallCounter {
    pub fn reset(&mut self, calls: u32) {
        self.conversation = self.conversation.wrapping_add(1);
        self.calls = calls;
    }

    pub fn set_calls(&mut self, calls: u32) {
        self.calls = calls;
    }

    pub fn record(&mut self, message: &Value) {
        self.calls = self.calls.saturating_add(1);
        if self.capturing {
            self.captured = assistant_text(message);
        }
    }

    /// Starts keeping the text of the next completed assistant message (the Hand off summary).
    pub fn begin_capture(&mut self) {
        self.capturing = true;
        self.captured = None;
    }

    pub fn end_capture(&mut self) -> Option<String> {
        self.capturing = false;
        self.captured.take()
    }
}

/// The assistant message of a `message_end` frame, `None` for any other frame or role.
pub fn assistant_message_end<'a>(frame_type: &str, frame: &'a Value) -> Option<&'a Value> {
    if frame_type != "message_end" {
        return None;
    }
    let message = frame.get("message")?;
    (message.get("role").and_then(Value::as_str) == Some("assistant")).then_some(message)
}

pub fn count_assistant_messages(messages: &[Value]) -> u32 {
    messages
        .iter()
        .filter(|m| m.get("role").and_then(Value::as_str) == Some("assistant"))
        .count() as u32
}

/// The visible text of an assistant message (string content, or its `text` blocks joined).
pub fn assistant_text(message: &Value) -> Option<String> {
    let text = match message.get("content")? {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn counts_only_assistant_message_end() {
        let frame = json!({ "message": { "role": "assistant", "content": "hi" } });
        assert!(assistant_message_end("message_end", &frame).is_some());
        assert!(assistant_message_end("message_update", &frame).is_none());
        let user = json!({ "message": { "role": "user", "content": "hi" } });
        assert!(assistant_message_end("message_end", &user).is_none());
        let history = [json!({ "role": "user" }), json!({ "role": "assistant" })];
        assert_eq!(count_assistant_messages(&history), 1);
    }

    #[test]
    fn captures_text_blocks_only_while_capturing() {
        let message = json!({ "role": "assistant", "content": [
            { "type": "thinking", "thinking": "x" }, { "type": "text", "text": " summary " }
        ] });
        let mut counter = CallCounter::default();
        counter.record(&message);
        assert_eq!(counter.end_capture(), None);
        counter.begin_capture();
        counter.record(&message);
        assert_eq!(counter.calls, 2);
        assert_eq!(counter.end_capture().as_deref(), Some("summary"));
    }

    #[test]
    fn reset_bumps_conversation_and_sets_calls() {
        let mut counter = CallCounter::default();
        counter.record(&json!({}));
        counter.reset(7);
        assert_eq!((counter.conversation, counter.calls), (1, 7));
    }
}
