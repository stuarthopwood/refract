// The last user prompt of a Conversation, for the Home view's Recent Sessions cards (issue #869,
// spec 059). The #862 preview reader scans the file's head and returns the FIRST prompt, so this
// reads a bounded tail window instead: 256 KiB, doubling to 2 MiB when the window holds no
// complete user message (one oversized line). The file is disk content, so every field is
// narrowed against the JSON, never assumed.

use std::path::Path;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

const TAIL_BYTES: u64 = 256 * 1024;
const MAX_TAIL_BYTES: u64 = TAIL_BYTES * 8;
/// A card shows one line; longer prompts are cut here.
pub const MAX_LINE_CHARS: usize = 160;

/// One line of text: whitespace collapsed, cut at `MAX_LINE_CHARS` with an ellipsis. `None` when
/// nothing is left.
pub fn one_line(text: &str) -> Option<String> {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    if collapsed.chars().count() <= MAX_LINE_CHARS {
        return Some(collapsed);
    }
    let cut: String = collapsed.chars().take(MAX_LINE_CHARS - 1).collect();
    Some(format!("{}…", cut.trim_end()))
}

fn user_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// The text of the last `message` entry with role `user` among `lines`, newest first.
fn last_user_in(lines: &[&str]) -> Option<String> {
    lines.iter().rev().find_map(|line| {
        let parsed: Value = serde_json::from_str(line.trim()).ok()?;
        if parsed.get("type").and_then(Value::as_str) != Some("message") {
            return None;
        }
        let message = parsed.get("message")?;
        if message.get("role").and_then(Value::as_str) != Some("user") {
            return None;
        }
        one_line(&user_text(message.get("content")?))
    })
}

/// Reads the last user prompt of the contained `.jsonl` file at `path`; `None` when the file has
/// none within the 2 MiB cap or cannot be read.
pub async fn read_last_user_line(path: &Path) -> Option<String> {
    let mut file = tokio::fs::File::open(path).await.ok()?;
    let len = file.metadata().await.ok()?.len();
    let mut window = TAIL_BYTES;
    loop {
        let start = len.saturating_sub(window);
        file.seek(std::io::SeekFrom::Start(start)).await.ok()?;
        let mut buffer = Vec::with_capacity((len - start) as usize);
        (&mut file).take(len - start).read_to_end(&mut buffer).await.ok()?;
        let text = String::from_utf8_lossy(&buffer);
        let mut lines: Vec<&str> = text.lines().collect();
        // A window that starts mid-file begins with a fragment of an earlier line.
        if start > 0 && !lines.is_empty() {
            lines.remove(0);
        }
        if let Some(found) = last_user_in(&lines) {
            return Some(found);
        }
        if start == 0 || window >= MAX_TAIL_BYTES {
            return None;
        }
        window *= 2;
    }
}
