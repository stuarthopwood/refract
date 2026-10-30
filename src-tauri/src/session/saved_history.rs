// Stopped Session history, read from OMP's saved file so no agent starts (#1205).
// The active branch ends at the last entry in file order, OMP's own fallback when no leaf is recorded.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;

use crate::omp::transcript::{NoticeLevel, TranscriptItem, TranscriptState};

/// Files larger than this are never read without an agent; a plain notice is shown instead.
pub const MAX_HISTORY_FILE_BYTES: u64 = 64 * 1024 * 1024;
/// Longer lines are skipped, so a file with no newline cannot grow the buffer.
const MAX_LINE_BYTES: u64 = 16 * 1024 * 1024;

/// Missing, empty, and too-large files get a plain notice instead of a blank transcript.
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

/// Accepts only a `.jsonl` file inside `session_dir`, so a registry value cannot point elsewhere.
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

/// Reads the file off the async worker; a `running` tool row becomes `interrupted`.
pub async fn read_saved_history(path: PathBuf, len: u64) -> SavedHistory {
    if len > MAX_HISTORY_FILE_BYTES {
        return SavedHistory::TooLarge;
    }
    tokio::task::spawn_blocking(move || parse_history_file(&path))
        .await
        .unwrap_or(SavedHistory::Missing)
}

/// Parses lines, skipping blank, malformed, and over-long ones, then follows the active branch.
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

/// Walks `parentId` links from `leaf`, bounded so a malformed cycle cannot loop forever.
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

/// Plain notice shown in place of history when it is missing, empty, or too large.
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
