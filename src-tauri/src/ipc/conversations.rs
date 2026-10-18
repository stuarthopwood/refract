// IPC handlers for `conversations.*` (contracts/ipc.md "Conversations", tasks.md T018/T025).
// `.list` is the registry-only arm (Phase 2(b)); `.startNew`/`.open` (Phase 3, tasks.md T025)
// drive the live `SessionAgent` via `AppState::session_manager`, going through
// `startStoppedSessionOnConversation`'s port (`SessionAgent::start_with_conversation`) for a
// `stopped` Session (issue #69). The directory-scan logic itself is a direct port of
// `src/main/conversations.ts`'s `listConversations` (no live-agent dependency at all -- a pure
// file read), folded into this one file rather than mirroring the Electron build's separate
// `src/main/conversations.ts` module. `list_conversations`/`ConversationInfo`/`build_snapshot`
// are `pub(crate)` so `ipc::sessions_agent`'s own `.open` arm can build the same `SessionSnapshot`
// shape (`contracts/ipc.md`'s own shared `buildSnapshot`, `src/main/ipc/util.ts`).

use serde::Serialize;
use serde_json::Value;

use super::{invalid_argument, not_found, AppState, Dispatcher, HandlerFuture};

pub fn register(d: &mut Dispatcher) {
    d.register("conversations.list", conversations_list);
    d.register("conversations.startNew", conversations_start_new);
    d.register("conversations.open", conversations_open);
}

/// `src/shared/model.ts`'s own `ConversationInfo` shape.
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

/// Port of `src/main/ipc/util.ts`'s own `buildSnapshot`, returned by `sessions.open`/`.recover`/
/// `.resume` and `conversations.startNew`/`.open` alike (contracts/ipc.md). `readout`/`subagents`
/// are out of this build's scope (`session::agent`'s own header): emitted as the documented
/// "nothing read yet" empty shape so the unmodified renderer's `SessionSnapshot` consumers never
/// see a missing field, never actually computed or updated afterward.
///
/// `detection` (lane R3, issue #786, gate-fix): a FRESHLY computed `resolve_termination()`
/// result, threaded in by callers that already paid for one (`ipc::sessions_agent`'s own
/// `attach_snapshot_core`/`resume_locked`) so this never re-derives a SECOND, possibly different
/// answer from `agent.runtime_view()`'s own cached (and, for a Session whose crash this run's
/// `on_exit` never saw, potentially stale-`false`) `terminatedUnexpectedly`. `None` (every other
/// caller here) leaves `runtime_view()`'s own value untouched.
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
    let conversations = list_conversations(
        session.session_dir.as_deref(),
        session.current_conversation.as_deref(),
    )
    .await;
    serde_json::json!({
        "runtime": runtime,
        "conversations": conversations,
        // Lane R5 (issue #788, code-review round 1): the LIVE readout/subagent list, not the
        // permanent "nothing read yet" shape -- `session::readout`/`session::subagents` each
        // retain their own last-computed value precisely so this snapshot can return it.
        "readout": crate::session::readout::current_readout_value(agent).await,
        "subagents": crate::session::subagents::current_summaries_value(agent).await,
        "advisorOn": crate::session::advisor::current_advisor_value(agent).await,
    })
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

/// Reads the file's first line for `title` (OMP writes a fixed-width, 256-byte `type: "title"`
/// slot there -- `omp://session.md` "File Format" -- so it is always complete well inside any
/// cap below) and scans for the first `role: 'user'` message for `preview`, using a hard byte
/// cap on the file read itself (`AsyncReadExt::take`), not merely a byte count checked between
/// complete lines -- a single oversized line can never read past the cap either.
///
/// Issue #862: OMP's own prelude between the header and the first user message --
/// `model_change`, `thinking_level_change`, `service_tier_change`, and now a `memory_recall`
/// `custom` entry (about 8.6 KB) plus `eager-todo-prelude`/`eager-task-prelude` `custom_message`
/// entries -- pushed that first user message to about 11 KB in the wild, past the old fixed
/// 8 KB window (`PREVIEW_SCAN_BYTES`), so the Conversation was silently skipped. Reading through
/// a `take`-limited handle means not one byte past the cap is ever read from disk, not just that
/// parsing stops there; a line (including the title line) is only ever parsed once its own
/// trailing `\n` has actually been read, so a record cut short by the cap is never fed to the
/// JSON parser.
///
/// Returns `None` only when real end-of-file is reached within the cap without ever finding a
/// user message (data-model.md: "files with zero user messages are not listed"). Returns
/// `Some((title, None))` when the cap is hit first: the Conversation still has a title (or an
/// empty one) and is still listed, just without a preview, rather than hidden -- reaching the
/// cap proves nothing about whether a user message exists further in the file. A `role: 'user'`
/// message with no text content (an image-only message, or one with an empty/missing `content`)
/// still counts as "found" -- `preview` becomes `Some(String::new())` rather than leaving the
/// scan to continue past it looking for a later, text-bearing message; FR-087's rule is "never
/// hide a row", not "find the first message with non-empty text".
async fn read_conversation_file(
    file: &std::path::Path,
) -> std::io::Result<Option<(String, Option<String>)>> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
    let handle = tokio::fs::File::open(file).await?;
    // Gate round 2: `take`'s own limit already bounds every read, so no extra `BufReader`
    // capacity on top of it is needed (a 64 KiB upfront allocation would be wasted I/O/memory for
    // every call, `BufReader::new`'s small default is enough). One byte of budget PAST the
    // intended cap is the sentinel that tells a file whose real size is EXACTLY
    // `PREVIEW_SCAN_HARD_CAP_BYTES` apart from one that genuinely holds more: only
    // `bytes_read_total > PREVIEW_SCAN_HARD_CAP_BYTES` (strictly past the cap, i.e. the sentinel
    // byte was actually consumed) counts as a cap hit below.
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
            // Real end of file: the `take` budget is one byte wider than the cap, so this can
            // only happen once the real file itself is exhausted, never as an artefact of the
            // cap alone.
            break;
        }
        bytes_read_total += bytes_read;
        if bytes_read_total > PREVIEW_SCAN_HARD_CAP_BYTES as u64 {
            // The file genuinely holds more than the cap: this piece may or may not be a whole
            // record, but reading further to find out is exactly what the cap exists to avoid,
            // so it is never parsed.
            cap_hit = true;
            break;
        }
        // A piece still within budget but missing its trailing `\n` is genuinely the file's own
        // last line (no closing newline at end of file) -- not the cap, which the check above
        // already ruled out -- so it is parsed exactly like any other line below; the next
        // `read_until` call reports real end-of-file and ends the loop normally.
        let trimmed = buf.trim_ascii();
        let current_index = line_index;
        line_index += 1;
        if !trimmed.is_empty() {
            // `from_slice` never panics or needs a prior UTF-8 check of its own: invalid UTF-8
            // (or any other malformed JSON) simply fails to parse here, same as any other
            // unparseable line -- it is skipped, never an `Err` that could drop the whole file.
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

/// `conversations.startNew` (contracts/omp-usage.md "New Conversation"): a `stopped` Session
/// goes through the stopped-Session Conversation switch (`startStoppedSessionOnConversation`'s
/// port); an already-live, idle Session calls `SessionAgent::start_new_conversation` directly.
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

/// `conversations.open` (contracts/omp-usage.md "Open an earlier Conversation"): `file` is
/// renderer-supplied and only accepted if it is one of this Session's own Conversations (never
/// an arbitrary filesystem path). A `stopped` Session goes through the stopped-Session
/// Conversation switch; an already-live, idle Session calls `SessionAgent::open_conversation`.
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
