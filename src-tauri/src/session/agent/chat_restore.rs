// Parses OMP's `abort_and_restore_queue` result into the shape `chat.stop` returns.

use serde_json::{json, Value};

const SUPPORTED_IMAGE_MIME_TYPES: [&str; 4] =
    ["image/png", "image/jpeg", "image/gif", "image/webp"];

/// Rebuilds each image from `{type, data, mimeType}` only, dropping malformed or unsupported entries.
fn restored_images(entry: &Value) -> Vec<Value> {
    let Some(images) = entry.get("images").and_then(Value::as_array) else {
        return Vec::new();
    };
    images
        .iter()
        .filter_map(|image| {
            let data = image.get("data").and_then(Value::as_str)?;
            let mime_type = image.get("mimeType").and_then(Value::as_str)?;
            if data.is_empty() || !SUPPORTED_IMAGE_MIME_TYPES.contains(&mime_type) {
                return None;
            }
            Some(json!({ "type": "image", "data": data, "mimeType": mime_type }))
        })
        .collect()
}

/// Steering messages come first, then follow-ups.
pub(super) fn parse_restored_queue(data: &Value) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    for queue in ["steering", "followUp"] {
        let Some(entries) = data.get(queue).and_then(Value::as_array) else {
            continue;
        };
        for entry in entries {
            let text = entry.get("text").and_then(Value::as_str).unwrap_or("");
            messages.push(json!({ "text": text, "images": restored_images(entry) }));
        }
    }
    json!({
        "messages": messages,
        "imagesDropped": data.get("imagesDropped").and_then(Value::as_bool) == Some(true),
        "truncated": data.get("truncated").and_then(Value::as_bool) == Some(true),
    })
}

/// The empty result returned when nothing was withdrawn.
pub(super) fn empty_restored_queue() -> Value {
    json!({ "messages": [], "imagesDropped": false, "truncated": false })
}
