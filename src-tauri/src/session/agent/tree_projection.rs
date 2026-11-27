// Pure parts of the Conversation tree commands (#696): OMP's raw `get_tree` becomes a flat list of
// message entries, and an OMP failure frame becomes a stable error code.

use std::collections::HashMap;

use serde_json::{json, Value};

use super::AgentError;

const PREVIEW_CHARS: usize = 200;

/// Flattens `get_tree` into message entries only, depth-first with children in OMP's order. Each entry's
/// `parentId` is its nearest message ancestor, since `model_change`, `label` and `custom` nodes are dropped.
/// `leafId` is likewise the nearest message at or above OMP's leaf. Walks with a stack because a long
/// Conversation nests two JSON levels per entry.
pub(super) fn project_tree(data: &Value) -> Value {
    let mut entries: Vec<Value> = Vec::new();
    // Every node, kept or not, to its nearest kept entry, so the leaf resolves even when it is a label.
    let mut nearest_kept: HashMap<&str, Option<&str>> = HashMap::new();
    let mut stack: Vec<(&Value, Option<&str>)> =
        roots(data).iter().rev().map(|n| (n, None)).collect();
    while let Some((node, kept_parent)) = stack.pop() {
        let entry = node.get("entry");
        let id = entry.and_then(|e| e.get("id")).and_then(Value::as_str);
        let kept = match (entry, id) {
            (Some(entry), Some(id)) if is_message(entry) => {
                entries.push(json!({
                    "id": id,
                    "parentId": kept_parent,
                    "role": role_of(entry),
                    "text": preview_of(entry),
                    "timestamp": entry.get("timestamp").and_then(Value::as_str),
                    "label": node.get("label").and_then(Value::as_str).filter(|l| !l.is_empty()),
                }));
                Some(id)
            }
            _ => kept_parent,
        };
        if let Some(id) = id {
            nearest_kept.insert(id, kept);
        }
        if let Some(children) = node.get("children").and_then(Value::as_array) {
            stack.extend(children.iter().rev().map(|child| (child, kept)));
        }
    }
    let leaf = data
        .get("leafId")
        .and_then(Value::as_str)
        .and_then(|leaf| nearest_kept.get(leaf).copied().flatten());
    json!({ "leafId": leaf, "entries": entries })
}

fn roots(data: &Value) -> &[Value] {
    data.get("tree")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn is_message(entry: &Value) -> bool {
    entry.get("type").and_then(Value::as_str) == Some("message")
}

fn role_of(entry: &Value) -> &str {
    entry
        .get("message")
        .and_then(|m| m.get("role"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
}

/// The first `PREVIEW_CHARS` characters of the message's text, whitespace collapsed.
fn preview_of(entry: &Value) -> String {
    let content = entry.get("message").and_then(|m| m.get("content"));
    let mut text = String::new();
    match content {
        Some(Value::String(s)) => text.push_str(s),
        Some(Value::Array(blocks)) => {
            for block in blocks {
                if block.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(t) = block.get("text").and_then(Value::as_str) {
                        text.push_str(t);
                        text.push(' ');
                    }
                }
            }
        }
        _ => {}
    }
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(PREVIEW_CHARS)
        .collect()
}

/// Maps an OMP `success: false` frame. `navigate_tree` carries a `code`; `fork` and `set_label` report an
/// unknown id as a message only, so those are recognised by their text.
pub(super) fn rpc_failure(res: &Value) -> AgentError {
    let message = res
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("unknown error");
    let code = match res.get("code").and_then(Value::as_str) {
        Some("session_busy") => "not-idle",
        Some("entry_not_found") => "entry-not-found",
        Some("ask_reanswer_unsupported") => "ask-reanswer-unsupported",
        Some(_) => "tree-failed",
        None if message.contains("not found") || message.contains("Invalid entry ID") => {
            "entry-not-found"
        }
        None => "tree-failed",
    };
    AgentError::new(code, message)
}

#[cfg(test)]
#[path = "tree_projection.test.rs"]
mod tests;
