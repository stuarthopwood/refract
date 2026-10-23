// Issue #1205 (FR-103): a stopped Session's current Conversation history, read straight from
// OMP's saved session file with no `omp` process, so showing a stopped Session never has to
// start its agent. Record format (docs/spike/FINDINGS.md item 63): a `type: "title"` first line,
// a `type: "session"` header, then entries carrying `id`/`parentId`; `type: "message"` entries
// hold the same `message` objects `get_messages` returns. One file can hold more than one branch:
// the active branch ends at the LAST entry in file order (OMP's own fallback when no leaf is
// recorded), and is walked back through `parentId` to its root.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;

use crate::omp::transcript::{NoticeLevel, TranscriptItem, TranscriptState};

/// What `read_saved_history` found. `Missing` and `Empty` are reported separately so the caller
/// can say so plainly (FR-024) instead of showing a blank transcript.
pub enum SavedHistory {
    Items(Vec<Arc<TranscriptItem>>),
    Missing,
    Empty,
}

/// One parsed entry: its parent link and, for a `message` entry, the nested `message` object.
struct Entry {
    parent_id: Option<String>,
    message: Option<Value>,
}

/// Reads `file` line by line, skipping blank, malformed, and header lines the same way
/// `ipc::conversations`'s `read_conversation_file` does, follows the active branch, and builds
/// the transcript items through `TranscriptState::from_history`. A tool row still `running` in
/// the file is settled `interrupted`: no process is left to finish it.
pub async fn read_saved_history(file: Option<&str>) -> SavedHistory {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let Some(file) = file.filter(|f| !f.is_empty()) else {
        return SavedHistory::Missing;
    };
    let Ok(handle) = tokio::fs::File::open(file).await else {
        return SavedHistory::Missing;
    };
    let mut reader = BufReader::new(handle);
    let mut entries: HashMap<String, Entry> = HashMap::new();
    let mut leaf: Option<String> = None;
    // Fallback for entries with no `id` at all (never seen in a real file, kept fail-safe).
    let mut unlinked: Vec<Value> = Vec::new();
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let Ok(record) = serde_json::from_slice::<Value>(buf.trim_ascii()) else {
            continue;
        };
        let kind = record.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "title" || kind == "session" {
            continue;
        }
        let message = (kind == "message")
            .then(|| record.get("message").filter(|m| m.is_object()).cloned())
            .flatten();
        match record.get("id").and_then(Value::as_str) {
            Some(id) => {
                let parent_id = record
                    .get("parentId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                entries.insert(id.to_string(), Entry { parent_id, message });
                leaf = Some(id.to_string());
            }
            None => unlinked.extend(message),
        }
    }
    let mut messages = active_branch_messages(&mut entries, leaf);
    messages.extend(unlinked);
    if messages.is_empty() {
        return SavedHistory::Empty;
    }
    let mut state = TranscriptState::from_history(&messages);
    state.set_terminated_unexpectedly(true);
    state.settle_interrupted_tool_rows();
    SavedHistory::Items(state.items().to_vec())
}

/// Walks from `leaf` back through `parentId` (bounded by the entry count, so a malformed cycle
/// can never loop forever) and returns that branch's messages oldest first.
fn active_branch_messages(
    entries: &mut HashMap<String, Entry>,
    leaf: Option<String>,
) -> Vec<Value> {
    let mut messages = Vec::new();
    let mut cursor = leaf;
    let mut steps = entries.len();
    while let Some(id) = cursor {
        if steps == 0 {
            break;
        }
        steps -= 1;
        let Some(entry) = entries.remove(&id) else {
            break;
        };
        messages.extend(entry.message);
        cursor = entry.parent_id;
    }
    messages.reverse();
    messages
}

/// The plain notice shown in place of history when the file is missing or holds no messages
/// (FR-103, FR-024).
pub fn notice_for(history: &SavedHistory) -> Option<TranscriptItem> {
    let text = match history {
        SavedHistory::Items(_) => return None,
        SavedHistory::Missing => "No saved history was found for this conversation.",
        SavedHistory::Empty => "This conversation has no messages yet.",
    };
    Some(TranscriptItem::Notice {
        id: "saved-history".to_string(),
        level: NoticeLevel::Info,
        text: text.to_string(),
    })
}
