// IPC handlers for `conversations.*`. `.list` reads the registry; `.startNew` and `.open` drive the live `SessionAgent`.
// The directory scan is a pure file read. `list_conversations`, `ConversationInfo`, and `build_snapshot` are `pub(crate)` so `sessions_agent` can reuse them.

use serde::Serialize;
use serde_json::Value;

use super::{invalid_argument, not_found, AppState, Dispatcher, HandlerFuture};

pub fn register(d: &mut Dispatcher) {
    d.register("conversations.list", conversations_list);
    d.register("conversations.startNew", conversations_start_new);
    d.register("conversations.open", conversations_open);
}

/// Conversation metadata returned by `conversations.list`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationInfo {
    file: String,
    id: String,
    created_at: String,
    title: String,
    preview: String,
    is_current: bool,
}

/// Builds the `SessionSnapshot` shared by `sessions.open`, `.recover`, `.resume`, and conversation switches.
/// `readout` and `subagents` are empty until read, so the renderer never sees a missing field.
pub(crate) async fn build_snapshot(
    session: &crate::store::registry::Session,
    agent: &std::sync::Arc<crate::session::SessionAgent>,
    detection: Option<&crate::session::termination::TerminationDetectionResult>,
) -> Value {
    let mut runtime = agent.runtime_view().await;
    if let Some(detection) = detection {
        let obj = runtime
            .as_object_mut()
            .expect("runtime_view payload is always a JSON object");
        if detection.terminated_unexpectedly {
            obj.insert("terminatedUnexpectedly".to_string(), Value::Bool(true));
            if detection.pending_tool_names.is_empty() {
                obj.remove("pendingToolNames");
            } else {
                obj.insert(
                    "pendingToolNames".to_string(),
                    serde_json::json!(detection.pending_tool_names),
                );
            }
        } else {
            obj.remove("terminatedUnexpectedly");
            obj.remove("pendingToolNames");
        }
    }
    inject_saved_history(&mut runtime, session).await;
    let conversations = list_conversations(
        session.session_dir.as_deref(),
        session.current_conversation.as_deref(),
    )
    .await;
    serde_json::json!({
        "runtime": runtime,
        "conversations": conversations,
        // Show the live readout and subagent list, not a placeholder.
        "readout": crate::session::readout::current_readout_value(agent).await,
        "subagents": crate::session::subagents::current_summaries_value(agent).await,
        "advisorOn": crate::session::advisor::current_advisor_value(agent).await,
    })
}

/// A `stopped` agent with no transcript of its own shows its Conversation's saved history, read from file.
/// A missing or empty file shows a plain notice instead.
async fn inject_saved_history(runtime: &mut Value, session: &crate::store::registry::Session) {
    use crate::session::saved_history::{notice_for, SavedHistory};
    use crate::session::saved_history_cache::load_saved_history;
    let stopped = runtime.get("status").and_then(Value::as_str) == Some("stopped");
    let has_live = runtime
        .get("transcript")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty());
    if !stopped || has_live {
        return;
    }
    let history = load_saved_history(
        session.session_dir.as_deref(),
        session.current_conversation.as_deref(),
    )
    .await;
    let transcript = match notice_for(&history) {
        Some(notice) => serde_json::json!([notice]),
        None => match history {
            SavedHistory::Items(items) => serde_json::json!(items),
            _ => return,
        },
    };
    if let Some(obj) = runtime.as_object_mut() {
        obj.insert("transcript".to_string(), transcript);
    }
}

pub fn conversations_list(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = match args.first().and_then(Value::as_str) {
            Some(id) => id.to_string(),
            None => {
                return Err(invalid_argument(
                    "conversations.list expects a string sessionId",
                ))
            }
        };
        let (session_dir, current_conversation) = {
            let registry = state.registry.lock().await;
            let session = registry
                .get_session(&session_id)
                .ok_or_else(|| not_found(format!("Session not found: {session_id}")))?;
            (
                session.session_dir.clone(),
                session.current_conversation.clone(),
            )
        };
        let conversations =
            list_conversations(session_dir.as_deref(), current_conversation.as_deref()).await;
        Ok(serde_json::to_value(conversations)
            .expect("ConversationInfo is always JSON-serialisable"))
    })
}

// File names are `<timestamp>_<uuid>.jsonl`, with the timestamp's `:` and `.` replaced by `-`.
// The timestamp prefix is a fixed 25 characters, so it is parsed by position, not by regex.
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
    if !is_digits(0..4)
        || chars[4] != '-'
        || !is_digits(5..7)
        || chars[7] != '-'
        || !is_digits(8..10)
        || chars[10] != 'T'
        || !is_digits(11..13)
    {
        return None;
    }
    if chars[13] != '-'
        || !is_digits(14..16)
        || chars[16] != '-'
        || !is_digits(17..19)
        || chars[19] != '-'
        || !is_digits(20..23)
    {
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

const PREVIEW_SCAN_HARD_CAP_BYTES: usize = 64 * 1024;
const PREVIEW_MAX_LENGTH: usize = 120;

/// Plain text of a stored user message, from a string or from `text` parts.
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

/// Reads the title and first user preview under a byte cap, so one oversized line cannot overrun it.
/// Reaching the cap still lists the Conversation, just without a preview.
async fn read_conversation_file(
    file: &std::path::Path,
) -> std::io::Result<Option<(String, Option<String>)>> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
    let handle = tokio::fs::File::open(file).await?;
    // `take` bounds every read, so `BufReader`'s default capacity is enough. The extra byte of budget
    // tells a file of exactly the cap size apart from a larger one (see the cap check below).
    let limited = handle.take(PREVIEW_SCAN_HARD_CAP_BYTES as u64 + 1);
    let mut reader = BufReader::new(limited);
    let mut title = String::new();
    let mut preview: Option<String> = None;
    let mut bytes_read_total: u64 = 0;
    let mut line_index = 0usize;
    let mut cap_hit = false;
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        let bytes_read = reader.read_until(b'\n', &mut buf).await? as u64;
        if bytes_read == 0 {
            // Real end of file (the budget is one byte wider than the cap).
            break;
        }
        bytes_read_total += bytes_read;
        if bytes_read_total > PREVIEW_SCAN_HARD_CAP_BYTES as u64 {
            // Past the cap: never parse a possibly partial record.
            cap_hit = true;
            break;
        }
        // A final line without `\n` is still parsed; the next read reports end of file.
        let trimmed = buf.trim_ascii();
        let current_index = line_index;
        line_index += 1;
        if !trimmed.is_empty() {
            // Invalid or malformed JSON is skipped, never an error that drops the whole file.
            if let Ok(parsed) = serde_json::from_slice::<Value>(trimmed) {
                if let Some(object) = parsed.as_object() {
                    if current_index == 0 {
                        if object.get("type").and_then(Value::as_str) == Some("title") {
                            title = object
                                .get("title")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                        }
                    } else if preview.is_none()
                        && object.get("type").and_then(Value::as_str) == Some("message")
                    {
                        if let Some(message) = object.get("message").and_then(Value::as_object) {
                            if message.get("role").and_then(Value::as_str) == Some("user") {
                                let text = message
                                    .get("content")
                                    .map(extract_user_text)
                                    .unwrap_or_default();
                                preview = Some(text.chars().take(PREVIEW_MAX_LENGTH).collect());
                            }
                        }
                    }
                }
            }
        }
        if preview.is_some() {
            break;
        }
    }
    if preview.is_none() && !cap_hit {
        return Ok(None);
    }
    Ok(Some((title, preview)))
}

fn same_file(a: &str, b: &str) -> bool {
    let resolve = |p: &str| {
        std::path::absolute(p)
            .map(|resolved| resolved.to_string_lossy().to_lowercase())
            .unwrap_or_else(|_| p.to_lowercase())
    };
    resolve(a) == resolve(b)
}

/// Lists every Conversation in `session_dir`, newest first. `session_dir == None` (no Conversation
/// has ever been started) and an unreadable directory both yield an empty list, never a failure.
pub(crate) async fn list_conversations(
    session_dir: Option<&str>,
    current_conversation: Option<&str>,
) -> Vec<ConversationInfo> {
    let Some(session_dir) = session_dir else {
        return Vec::new();
    };
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
        let Some(entry_name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Some((created_at, id)) = parse_file_name(&entry_name) else {
            continue;
        };
        let file_path = entry.path();
        let Ok(metadata) = tokio::fs::metadata(&file_path).await else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let Ok(Some((title, preview))) = read_conversation_file(&file_path).await else {
            continue;
        };
        let file = file_path.to_string_lossy().into_owned();
        let is_current = current_conversation.is_some_and(|current| same_file(&file, current));
        results.push(ConversationInfo {
            file,
            id,
            created_at,
            title,
            preview: preview.unwrap_or_default(),
            is_current,
        });
    }
    results.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    results
}

/// `conversations.startNew`. A `stopped` Session starts on a new Conversation; a live one starts it in place.
pub fn conversations_start_new(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(session_id) = args.first().and_then(Value::as_str).map(str::to_string) else {
            return Err(invalid_argument(
                "conversations.startNew expects a string sessionId",
            ));
        };
        if state
            .registry
            .lock()
            .await
            .get_session(&session_id)
            .is_none()
        {
            return Err(not_found(format!("Session not found: {session_id}")));
        }
        let agent = state.session_manager.get_or_create_agent(&session_id);
        let result = if agent.status().await == crate::session::SessionStatus::Stopped {
            agent.start_with_conversation(None).await
        } else {
            agent.start_new_conversation().await
        };
        if let Err(err) = result {
            return Err(super::map_agent_error(err));
        }
        let session = state
            .registry
            .lock()
            .await
            .get_session(&session_id)
            .cloned()
            .ok_or_else(|| not_found(format!("Session not found: {session_id}")))?;
        Ok(build_snapshot(&session, &agent, None).await)
    })
}

/// `conversations.open`. `file` must be one of this Session's own Conversations, never a free path.
pub fn conversations_open(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let (Some(session_id), Some(file)) = (
            args.first().and_then(Value::as_str).map(str::to_string),
            args.get(1).and_then(Value::as_str).map(str::to_string),
        ) else {
            return Err(invalid_argument(
                "conversations.open expects (sessionId, file) strings",
            ));
        };
        let session = state
            .registry
            .lock()
            .await
            .get_session(&session_id)
            .cloned()
            .ok_or_else(|| not_found(format!("Session not found: {session_id}")))?;
        let own_conversations = list_conversations(
            session.session_dir.as_deref(),
            session.current_conversation.as_deref(),
        )
        .await;
        let resolved_file = std::path::absolute(&file)
            .map(|p| p.to_string_lossy().to_lowercase())
            .unwrap_or_else(|_| file.to_lowercase());
        let matched = own_conversations.into_iter().find(|c| {
            std::path::absolute(&c.file)
                .map(|p| p.to_string_lossy().to_lowercase())
                .unwrap_or_else(|_| c.file.to_lowercase())
                == resolved_file
        });
        let Some(matched) = matched else {
            return Err(invalid_argument(
                "conversations.open file must be one of this Session's own Conversations",
            ));
        };
        let agent = state.session_manager.get_or_create_agent(&session_id);
        let result = if agent.status().await == crate::session::SessionStatus::Stopped {
            agent
                .start_with_conversation(Some(matched.file.clone()))
                .await
        } else {
            agent.open_conversation(matched.file.clone()).await
        };
        if let Err(err) = result {
            return Err(super::map_agent_error(err));
        }
        let session = state
            .registry
            .lock()
            .await
            .get_session(&session_id)
            .cloned()
            .ok_or_else(|| not_found(format!("Session not found: {session_id}")))?;
        Ok(build_snapshot(&session, &agent, None).await)
    })
}
