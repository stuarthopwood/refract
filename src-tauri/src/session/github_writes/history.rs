// Rebuilds GitHub writes from a saved history by pairing `toolCall` blocks with `toolResult` messages.

use std::collections::HashMap;

use serde_json::Value;

use super::{detect, join_text, GithubWrite, ToolCallRecord};

/// Writes in chronological order; timestamps come from the messages, not the clock.
pub(in crate::session) fn detect_in_history(messages: &[Value]) -> Vec<GithubWrite> {
    let mut calls: HashMap<&str, (&str, &Value, i64)> = HashMap::new();
    let mut writes = Vec::new();
    for message in messages {
        let at = message
            .get("timestamp")
            .and_then(Value::as_f64)
            .map_or(0, |f| f as i64);
        match message.get("role").and_then(Value::as_str) {
            Some("assistant") => {
                let Some(parts) = message.get("content").and_then(Value::as_array) else {
                    continue;
                };
                for part in parts {
                    if part.get("type").and_then(Value::as_str) != Some("toolCall") {
                        continue;
                    }
                    let (Some(id), Some(name)) = (
                        part.get("id").and_then(Value::as_str),
                        part.get("name").and_then(Value::as_str),
                    ) else {
                        continue;
                    };
                    if matches!(name, "bash" | "eval") {
                        if let Some(args) = part.get("arguments") {
                            calls.insert(id, (name, args, at));
                        }
                    }
                }
            }
            Some("toolResult") => {
                let Some(id) = message.get("toolCallId").and_then(Value::as_str) else {
                    continue;
                };
                let Some((tool, args, call_at)) = calls.remove(id) else {
                    continue;
                };
                let output = message.get("content").map(join_text).unwrap_or_default();
                let is_error = message.get("isError").and_then(Value::as_bool) == Some(true);
                writes.extend(detect(&ToolCallRecord {
                    tool,
                    args,
                    output: &output,
                    is_error,
                    at_ms: if at > 0 { at } else { call_at },
                }));
            }
            _ => {}
        }
    }
    writes
}
