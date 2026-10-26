// Issue #1205 (FR-103): a stopped Session's current Conversation history, read straight from
// OMP's saved session file with no `omp` process, so showing a stopped Session never has to
// start its agent. Record format (docs/spike/FINDINGS.md item 63): a `type: "title"` first line,
// a `type: "session"` header, then entries carrying `id`/`parentId`; `type: "message"` entries
// hold the same `message` objects `get_messages` returns. One file can hold more than one branch:
// the active branch ends at the LAST entry in file order (OMP's own fallback when no leaf is
// recorded), and is walked back through `parentId` to its root.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;

use crate::omp::transcript::{NoticeLevel, TranscriptItem, TranscriptState};

/// Files larger than this are never read without an agent; a plain notice is shown instead.
pub const MAX_HISTORY_FILE_BYTES: u64 = 64 * 1024 * 1024;
/// A single line longer than this is skipped, so a file with no newline cannot grow the buffer.
const MAX_LINE_BYTES: u64 = 16 * 1024 * 1024;

/// What `read_saved_history` found. `Missing`, `Empty`, and `TooLarge` are reported separately
/// so the caller can say so plainly (FR-024) instead of showing a blank transcript.
pub enum SavedHistory {
    Items(Arc<Vec<Arc<TranscriptItem>>>),
    Missing,
    Empty,
    TooLarge,
}

/// One parsed entry: its parent link and, for a `message` entry, the nested `message` object.
struct Entry {
    parent_id: Option<String>,
    message: Option<Value>,
}

/// Canonicalises `file` and returns it only when it is a `.jsonl` file inside `session_dir`, so
/// a registry value can never point the reader anywhere else.
pub async fn contained_history_file(
    session_dir: Option<&str>,
    file: Option<&str>,
) -> Option<PathBuf> {
    let dir = session_dir.filter(|d| !d.is_empty())?;
    let file = file.filter(|f| !f.is_empty())?;
    let dir = tokio::fs::canonicalize(dir).await.ok()?;
    let file = tokio::fs::canonicalize(file).await.ok()?;
    let is_jsonl = file
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl"));
    (is_jsonl && file.starts_with(&dir)).then_some(file)
}

/// Reads the contained history file at `path` (already sized at `len` bytes by the caller) off
/// the async worker. A tool row still `running` in the file is settled `interrupted`: no process
/// is left to finish it.
pub async fn read_saved_history(path: PathBuf, len: u64) -> SavedHistory {
    if len > MAX_HISTORY_FILE_BYTES {
        return SavedHistory::TooLarge;
    }
    tokio::task::spawn_blocking(move || parse_history_file(&path))
        .await
        .unwrap_or(SavedHistory::Missing)
}

/// Reads `path` line by line, skipping blank, malformed, over-long, and header lines the same way
/// `ipc::conversations`'s `read_conversation_file` does, follows the active branch, and builds
/// the transcript items through `TranscriptState::from_history`.
fn parse_history_file(path: &Path) -> SavedHistory {
    let Ok(handle) = std::fs::File::open(path) else {
        return SavedHistory::Missing;
    };
    let mut reader = BufReader::new(handle);
    let mut entries: HashMap<String, Entry> = HashMap::new();
    let mut leaf: Option<String> = None;
    // Fallback for entries with no `id` at all (never seen in a real file, kept fail-safe).
    let mut unlinked: Vec<Value> = Vec::new();
    let mut buf: Vec<u8> = Vec::new();
    let mut first_read = true;
    loop {
        buf.clear();
        let read = (&mut reader)
            .take(MAX_LINE_BYTES + 1)
            .read_until(b'\n', &mut buf);
        match read {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) if first_read => return SavedHistory::Missing,
            Err(err) => {
                log::debug!("saved history: stopped reading {}: {err}", path.display());
                break;
            }
        }
        first_read = false;
        if buf.len() as u64 > MAX_LINE_BYTES {
            if let Err(err) = skip_rest_of_line(&mut reader) {
                log::debug!("saved history: stopped reading {}: {err}", path.display());
                break;
            }
            continue;
        }
        let Ok(mut record) = serde_json::from_slice::<Value>(buf.trim_ascii()) else {
            continue;
        };
        let kind = record.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "title" || kind == "session" {
            continue;
        }
        let message = if kind == "message" {
            record
                .get_mut("message")
                .map(Value::take)
                .filter(Value::is_object)
        } else {
            None
        };
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
    drop(entries);
    messages.extend(unlinked);
    if messages.is_empty() {
        return SavedHistory::Empty;
    }
    let mut state = TranscriptState::from_history(&messages);
    drop(messages);
    state.set_terminated_unexpectedly(true);
    state.settle_interrupted_tool_rows();
    SavedHistory::Items(Arc::new(state.items().to_vec()))
}

/// Discards the remainder of an over-long line without buffering it.
fn skip_rest_of_line(reader: &mut impl BufRead) -> std::io::Result<()> {
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            return Ok(());
        }
        match chunk.iter().position(|b| *b == b'\n') {
            Some(at) => {
                reader.consume(at + 1);
                return Ok(());
            }
            None => {
                let n = chunk.len();
                reader.consume(n);
            }
        }
    }
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

/// The plain notice shown in place of history when the file is missing, holds no messages, or
/// is too large to read without an agent (FR-103, FR-024).
pub fn notice_for(history: &SavedHistory) -> Option<TranscriptItem> {
    let text = match history {
        SavedHistory::Items(_) => return None,
        SavedHistory::Missing => "No saved history was found for this conversation.",
        SavedHistory::Empty => "This conversation has no messages yet.",
        SavedHistory::TooLarge => {
            "This conversation's saved history is too large to show. Start the agent to see it."
        }
    };
    Some(TranscriptItem::Notice {
        id: "saved-history".to_string(),
        level: NoticeLevel::Info,
        text: text.to_string(),
    })
}
