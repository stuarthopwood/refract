// IPC handlers for `chat.*` (contracts/ipc.md "Chat", tasks.md T026). Ports `chat.send`
// (including the native `/new` slash-command routing and the allowlisted-commands validation,
// `src/main/ipc/chat.ts`), `.stop`, `.answer`, `.removeQueued`, and `.commands`. `.sendNow`,
// `.predictWord`, `.predictWordFeedback`, `.setVisibleSubagent`, and `.subagentSnapshot` are not
// ported (model roles/subagents/predict-word are out of this slice's scope, `session::agent`'s
// own header).

use serde_json::Value;

use crate::session::agent::{
    classify_slash_invocation, is_chat_answer, parse_slash_command, SlashInvocationClassification,
};
use crate::session::SessionManager;

use super::{invalid_argument, not_found, AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("chat.send", chat_send);
    d.register("chat.stop", chat_stop);
    d.register("chat.removeQueued", chat_remove_queued);
    d.register("chat.answer", chat_answer);
    d.register("chat.commands", chat_commands);
}

/// Maximum accepted decoded image size (spec 009 research.md Decision 3), mirrored from
/// `src/shared/images.ts`'s own `MAX_IMAGE_INPUT_BYTES` (20 MiB) -- not a declared dependency of
/// this crate's `shared/` tree, so re-declared here.
const MAX_IMAGE_INPUT_BYTES: u64 = 20 * 1024 * 1024;

/// Port of `src/shared/slash-commands.ts`'s own `NATIVE_RESERVED_COMMANDS`: Refract's own
/// native/reserved command names (constitution I), refused locally even if OMP later recognizes
/// one of them as a real command -- never forwarded as a literal prompt.
const NATIVE_RESERVED_COMMANDS: &[&str] = &[
    "new",
    "resume",
    "plan",
    "fork",
    "settings",
    "pause",
    "plan-review",
    "btw",
];

fn manager(state: &AppState) -> &std::sync::Arc<SessionManager> {
    &state.session_manager
}

/// Port of `chat.ts`'s own `mapChatError`: every `chat.send`/`.stop`/`.removeQueued` failure
/// maps straight through (`AgentError::code` already matches `src/shared/ipc.ts`'s own
/// `IpcErrorCode` values, same as `AgentNotRunningError`/`PromptFailedError`'s own `code` field).
fn map_chat_error(err: crate::session::AgentError) -> IpcError {
    IpcError::new(err.code, err.message)
}

/// Decoded byte length of a base64 string, computed from the string's own length (never a live
/// decode), port of `images.ts`'s own `decodedBase64ByteLength`.
fn decoded_base64_byte_length(data: &str) -> u64 {
    let len = data.len() as u64;
    if len == 0 {
        return 0;
    }
    let padding = if data.ends_with("==") {
        2
    } else if data.ends_with('=') {
        1
    } else {
        0
    };
    (len * 3 / 4).saturating_sub(padding)
}

/// Decodes the first 24 base64 characters (18 bytes) of `data` -- enough to cover every
/// supported format's magic-byte signature with headroom (port of `validateImageAttachment`'s
/// own prefix decode).
fn decode_base64_prefix(data: &str) -> Vec<u8> {
    let prefix: String = data.chars().take(24).collect();
    let stripped: Vec<u8> = prefix
        .bytes()
        .filter(|b| !b.is_ascii_whitespace() && *b != b'=')
        .collect();
    let value = |byte: u8| -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };
    let mut out = Vec::with_capacity(stripped.len() * 3 / 4 + 3);
    let mut group = [0u8; 4];
    let mut group_len = 0usize;
    for byte in stripped {
        let Some(v) = value(byte) else { break };
        group[group_len] = v;
        group_len += 1;
        if group_len == 4 {
            out.push((group[0] << 2) | (group[1] >> 4));
            out.push((group[1] << 4) | (group[2] >> 2));
            out.push((group[2] << 6) | group[3]);
            group_len = 0;
        }
    }
    match group_len {
        2 => out.push((group[0] << 2) | (group[1] >> 4)),
        3 => {
            out.push((group[0] << 2) | (group[1] >> 4));
            out.push((group[1] << 4) | (group[2] >> 2));
        }
        _ => {}
    }
    out
}

/// Port of `shared/images.ts`'s own `matchesImageSignature`.
fn matches_image_signature(bytes: &[u8], mime_type: &str) -> bool {
    match mime_type {
        "image/png" => {
            bytes.len() >= 16
                && bytes[0..8] == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
                && bytes[12..16] == [0x49, 0x48, 0x44, 0x52]
        }
        "image/jpeg" => {
            bytes.len() >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff
        }
        "image/gif" => {
            bytes.len() >= 6
                && bytes[0..4] == *b"GIF8"
                && (bytes[4] == 0x37 || bytes[4] == 0x39)
                && bytes[5] == 0x61
        }
        "image/webp" => bytes.len() >= 12 && bytes[0..4] == *b"RIFF" && bytes[8..12] == *b"WEBP",
        _ => false,
    }
}

const SUPPORTED_IMAGE_MIME_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];

/// Port of `omp/images.ts`'s own `validateImageAttachment` (FR-018, constitution Principle V):
/// re-validates every `images` entry independently of the renderer's own paste-time check.
fn validate_image_attachment(image: &Value) -> Result<(), IpcError> {
    let mime_type = image.get("mimeType").and_then(Value::as_str).unwrap_or("");
    if !SUPPORTED_IMAGE_MIME_TYPES.contains(&mime_type) {
        return Err(IpcError::new(
            "unsupported-image-type",
            format!("Unsupported image type: {mime_type}"),
        ));
    }
    let data = image.get("data").and_then(Value::as_str).unwrap_or("");
    if decoded_base64_byte_length(data) > MAX_IMAGE_INPUT_BYTES {
        return Err(IpcError::new(
            "image-too-large",
            "Image exceeds the 20 MiB limit",
        ));
    }
    let prefix = decode_base64_prefix(data);
    if !matches_image_signature(&prefix, mime_type) {
        return Err(IpcError::new(
            "unsupported-image-type",
            format!("Unsupported image type: {mime_type}"),
        ));
    }
    Ok(())
}

/// Port of `chat.ts`'s own `parseImagesArgument`: shape-checks, then independently re-validates
/// every entry (FR-018) before ever building the outgoing `prompt` command.
fn parse_images_argument(images: Option<&Value>) -> Result<Option<Vec<Value>>, IpcError> {
    let Some(images) = images else {
        return Ok(None);
    };
    if images.is_null() {
        return Ok(None);
    }
    let Some(array) = images.as_array() else {
        return Err(invalid_argument(
            "chat.send expects images to be an array when provided",
        ));
    };
    let mut parsed = Vec::with_capacity(array.len());
    for entry in array {
        let Some(candidate) = entry.as_object() else {
            return Err(invalid_argument("chat.send: each image must be an object"));
        };
        if candidate.get("type").and_then(Value::as_str) != Some("image") {
            return Err(invalid_argument(
                "chat.send: each image must be { type: 'image', data: string, mimeType: string }",
            ));
        }
        let Some(data) = candidate.get("data").and_then(Value::as_str) else {
            return Err(invalid_argument("chat.send: image data must be a string"));
        };
        if data.is_empty() {
            return Err(invalid_argument("chat.send: image data must not be empty"));
        }
        let image = entry.clone();
        validate_image_attachment(&image)?;
        parsed.push(image);
    }
    Ok(Some(parsed))
}

pub fn chat_send(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(session_id) = args.first().and_then(Value::as_str) else {
            return Err(invalid_argument(
                "chat.send expects (sessionId, text) strings",
            ));
        };
        let Some(text) = args.get(1).and_then(Value::as_str) else {
            return Err(invalid_argument(
                "chat.send expects (sessionId, text) strings",
            ));
        };
        let parsed_images = parse_images_argument(args.get(2))?;
        if state
            .registry
            .lock()
            .await
            .get_session(session_id)
            .is_none()
        {
            return Err(not_found(format!("Session not found: {session_id}")));
        }
        let agent = manager(&state).get_or_create_agent(session_id);

        if let Some((name, rest)) = parse_slash_command(text) {
            if name == "new" && rest.is_empty() {
                agent
                    .start_new_conversation()
                    .await
                    .map_err(map_chat_error)?;
                return Ok(serde_json::json!({ "queued": false }));
            }
            // Port of `slash-commands.ts`'s own `NATIVE_RESERVED_COMMANDS` (chat.ts:125-130):
            // refused locally before classification, never forwarded to OMP even if a future
            // OMP version later recognizes one of these names as a real command.
            if NATIVE_RESERVED_COMMANDS.contains(&name.as_str()) {
                let suffix = if rest.is_empty() {
                    String::new()
                } else {
                    format!(" {rest}")
                };
                return Err(IpcError::new(
                    "unknown-command",
                    format!("Unknown command: /{name}{suffix}"),
                ));
            }
            let commands = agent.available_commands().await;
            match classify_slash_invocation(&name, &rest, &commands) {
                SlashInvocationClassification::UnknownCommand => {
                    let suffix = if rest.is_empty() {
                        String::new()
                    } else {
                        format!(" {rest}")
                    };
                    return Err(IpcError::new(
                        "unknown-command",
                        format!("Unknown command: /{name}{suffix}"),
                    ));
                }
                SlashInvocationClassification::UnsupportedArguments => {
                    let suffix = if rest.is_empty() {
                        String::new()
                    } else {
                        format!(" {rest}")
                    };
                    return Err(IpcError::new(
                        "unsupported-arguments",
                        format!("/{name}{suffix} doesn't support arguments yet."),
                    ));
                }
                SlashInvocationClassification::Supported => {
                    // A real OMP-side command (from `available_commands_update`): fall through
                    // and forward it as a normal prompt below.
                }
            }
        }

        let result = agent
            .send(text.to_string(), parsed_images)
            .await
            .map_err(map_chat_error)?;
        Ok(result)
    })
}

pub fn chat_stop(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(session_id) = args.first().and_then(Value::as_str) else {
            return Err(invalid_argument("chat.stop expects a string sessionId"));
        };
        if state
            .registry
            .lock()
            .await
            .get_session(session_id)
            .is_none()
        {
            return Err(not_found(format!("Session not found: {session_id}")));
        }
        manager(&state)
            .get_or_create_agent(session_id)
            .stop()
            .await
            .map_err(map_chat_error)?;
        Ok(Value::Null)
    })
}

pub fn chat_remove_queued(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(session_id) = args.first().and_then(Value::as_str) else {
            return Err(invalid_argument("chat.removeQueued expects (sessionId, text, queue) with queue 'followUp' or 'steering'"));
        };
        let Some(text) = args.get(1).and_then(Value::as_str) else {
            return Err(invalid_argument("chat.removeQueued expects (sessionId, text, queue) with queue 'followUp' or 'steering'"));
        };
        let queue = args.get(2).and_then(Value::as_str).unwrap_or("");
        if queue != "followUp" && queue != "steering" {
            return Err(invalid_argument("chat.removeQueued expects (sessionId, text, queue) with queue 'followUp' or 'steering'"));
        }
        if state
            .registry
            .lock()
            .await
            .get_session(session_id)
            .is_none()
        {
            return Err(not_found(format!("Session not found: {session_id}")));
        }
        let result = manager(&state)
            .get_or_create_agent(session_id)
            .remove_queued(text.to_string(), queue)
            .await
            .map_err(map_chat_error)?;
        Ok(result)
    })
}

pub fn chat_answer(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(session_id) = args.first().and_then(Value::as_str) else {
            return Err(invalid_argument(
                "chat.answer expects (sessionId, requestId, answer)",
            ));
        };
        let Some(request_id) = args.get(1).and_then(Value::as_str) else {
            return Err(invalid_argument(
                "chat.answer expects (sessionId, requestId, answer)",
            ));
        };
        let Some(answer) = args.get(2) else {
            return Err(invalid_argument(
                "chat.answer expects (sessionId, requestId, answer)",
            ));
        };
        if !is_chat_answer(answer) {
            return Err(invalid_argument(
                "chat.answer expects (sessionId, requestId, answer)",
            ));
        }
        if state
            .registry
            .lock()
            .await
            .get_session(session_id)
            .is_none()
        {
            return Err(not_found(format!("Session not found: {session_id}")));
        }
        manager(&state)
            .get_or_create_agent(session_id)
            .answer_request(request_id.to_string(), answer.clone())
            .await
            .map_err(|err| not_found(err.message))?;
        Ok(Value::Null)
    })
}

pub fn chat_commands(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(session_id) = args.first().and_then(Value::as_str) else {
            return Err(invalid_argument("chat.commands expects a string sessionId"));
        };
        if state
            .registry
            .lock()
            .await
            .get_session(session_id)
            .is_none()
        {
            return Err(not_found(format!("Session not found: {session_id}")));
        }
        let commands = manager(&state)
            .get_or_create_agent(session_id)
            .available_commands()
            .await;
        Ok(Value::Array(commands))
    })
}
