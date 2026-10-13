// IPC handler for `conversations.list` (contracts/ipc.md "Conversations", tasks.md T018). Only
// the registry-only `.list` arm is ported here -- `.startNew`/`.open` need the live
// `SessionAgent` (Phase 3) and stay unregistered, matching `parity.md`'s own milestone marking
// (both channels are milestone 1, but the `startStoppedSessionOnConversation`/live-agent body
// those arms need does not exist yet in this slice). The directory-scan logic itself is a direct
// port of `src/main/conversations.ts`'s `listConversations` (there is no live-agent dependency in
// that half at all -- it is a pure file read), folded into this one file rather than mirroring
// the Electron build's separate `src/main/conversations.ts` module, since no other milestone-1
// handler in this slice needs it.

use serde::Serialize;
use serde_json::Value;

use super::{invalid_argument, not_found, AppState, HandlerFuture};

/// `src/shared/model.ts`'s own `ConversationInfo` shape.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationInfo {
    file: String,
    id: String,
    created_at: String,
    title: String,
    preview: String,
    is_current: bool,
}

pub fn conversations_list(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = match args.first().and_then(Value::as_str) {
            Some(id) => id.to_string(),
            None => return Err(invalid_argument("conversations.list expects a string sessionId")),
        };
        let (session_dir, current_conversation) = {
            let registry = state.registry.lock().await;
            let session = registry.get_session(&session_id).ok_or_else(|| not_found(format!("Session not found: {session_id}")))?;
            (session.session_dir.clone(), session.current_conversation.clone())
        };
        let conversations = list_conversations(session_dir.as_deref(), current_conversation.as_deref()).await;
        Ok(serde_json::to_value(conversations).expect("ConversationInfo is always JSON-serialisable"))
    })
}

// A Conversation file is named `<timestamp with `:`/`.` replaced by `-`>_<uuid>.jsonl`, e.g.
// `2026-09-30T18-02-07-675Z_01a0f37b-1fbb-7513-afb3-77377123bcb7.jsonl`. The fixed-width prefix
// before the uuid is always exactly 25 characters (`YYYY-MM-DDTHH-mm-ss-mmmZ_`); this is a manual
// positional parse of that fixed shape rather than a regex (no `regex` crate dependency in this
// build's `Cargo.toml`), reconstructing the same ISO timestamp
// `src/main/conversations.ts`'s own `FILE_NAME_RE`-based `parseFileName` does.
fn parse_file_name(file_name: &str) -> Option<(String, String)> {
    const SUFFIX: &str = ".jsonl";
    const PREFIX_LEN: usize = 25;
    if !file_name.ends_with(SUFFIX) || file_name.len() <= PREFIX_LEN + SUFFIX.len() {
        return None;
    }
    let chars: Vec<char> = file_name.chars().collect();
    if chars.len() < PREFIX_LEN {
        return None;
    }
    let is_digits = |range: std::ops::Range<usize>| chars[range].iter().all(|c| c.is_ascii_digit());
    if !is_digits(0..4) || chars[4] != '-' || !is_digits(5..7) || chars[7] != '-' || !is_digits(8..10) || chars[10] != 'T' || !is_digits(11..13) {
        return None;
    }
    if chars[13] != '-' || !is_digits(14..16) || chars[16] != '-' || !is_digits(17..19) || chars[19] != '-' || !is_digits(20..23) {
        return None;
    }
    if chars[23] != 'Z' || chars[24] != '_' {
        return None;
    }
    let date_part: String = chars[0..13].iter().collect();
    let minute: String = chars[14..16].iter().collect();
    let second: String = chars[17..19].iter().collect();
    let millis: String = chars[20..23].iter().collect();
    let id_end = file_name.len() - SUFFIX.len();
    let id = file_name[PREFIX_LEN..id_end].to_string();
    if id.is_empty() {
        return None;
    }
    Some((format!("{date_part}:{minute}:{second}.{millis}Z"), id))
}

const PREVIEW_SCAN_BYTES: usize = 8 * 1024;
const PREVIEW_MAX_LENGTH: usize = 120;

async fn read_preview_window(file: &std::path::Path) -> std::io::Result<String> {
    use tokio::io::AsyncReadExt;
    let mut handle = tokio::fs::File::open(file).await?;
    let mut buffer = vec![0u8; PREVIEW_SCAN_BYTES];
    let bytes_read = handle.read(&mut buffer).await?;
    buffer.truncate(bytes_read);
    Ok(String::from_utf8_lossy(&buffer).into_owned())
}

/// Extracts plain text from a stored `role: 'user'` message's `content` (string, or an array of
/// `{ type: 'text', text: '...' }` parts).
fn extract_user_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part.as_object())
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// Reads the file's first line for `title` and the first `role: 'user'` message within the first
/// 8 KB for `preview`. Returns `None` when no user message is found there, which the caller treats
/// as "skip this file" (data-model.md: "files with no user message skipped").
async fn read_conversation_file(file: &std::path::Path) -> std::io::Result<Option<(String, String)>> {
    let window = read_preview_window(file).await?;
    let mut title = String::new();
    let mut preview: Option<String> = None;
    for (index, line) in window.split('\n').enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // The last line in an 8 KB window may be cut off mid-record; skip it rather than fail
        // the whole scan.
        let Ok(parsed) = serde_json::from_str::<Value>(trimmed) else { continue };
        let Some(object) = parsed.as_object() else { continue };
        if index == 0 {
            if object.get("type").and_then(Value::as_str) == Some("title") {
                title = object.get("title").and_then(Value::as_str).unwrap_or("").to_string();
            }
            continue;
        }
        if preview.is_some() {
            continue;
        }
        if object.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(message) = object.get("message").and_then(Value::as_object) else { continue };
        if message.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let Some(content) = message.get("content") else { continue };
        let text = extract_user_text(content);
        if !text.is_empty() {
            preview = Some(text.chars().take(PREVIEW_MAX_LENGTH).collect());
        }
    }
    Ok(preview.map(|preview| (title, preview)))
}

fn same_file(a: &str, b: &str) -> bool {
    let resolve = |p: &str| std::path::absolute(p).map(|resolved| resolved.to_string_lossy().to_lowercase()).unwrap_or_else(|_| p.to_lowercase());
    resolve(a) == resolve(b)
}

/// Lists every Conversation in `session_dir`, newest first. `session_dir == None` (no Conversation
/// has ever been started) and an unreadable directory both yield an empty list, never a failure.
async fn list_conversations(session_dir: Option<&str>, current_conversation: Option<&str>) -> Vec<ConversationInfo> {
    let Some(session_dir) = session_dir else { return Vec::new() };
    let mut entries = match tokio::fs::read_dir(session_dir).await {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };

    let mut results = Vec::new();
    loop {
        let entry = match entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(_) => break,
        };
        let Some(entry_name) = entry.file_name().to_str().map(str::to_string) else { continue };
        let Some((created_at, id)) = parse_file_name(&entry_name) else { continue };
        let file_path = entry.path();
        let Ok(metadata) = tokio::fs::metadata(&file_path).await else { continue };
        if !metadata.is_file() {
            continue;
        }
        let Ok(Some((title, preview))) = read_conversation_file(&file_path).await else { continue };
        let file = file_path.to_string_lossy().into_owned();
        let is_current = current_conversation.is_some_and(|current| same_file(&file, current));
        results.push(ConversationInfo { file, id, created_at, title, preview, is_current });
    }
    results.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    results
}
