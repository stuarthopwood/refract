// IPC handlers for `chat.*` (contracts/ipc.md "Chat", tasks.md T026). Ports `chat.send`
// (including the native `/new` slash-command routing and the allowlisted-commands validation,
// `src/main/ipc/chat.ts`), `.stop`, `.answer`, `.removeQueued`, `.commands`, and `.sendNow`
// (issue #540, lane R4). `.predictWord`, `.predictWordFeedback`, `.setVisibleSubagent`, and
// `.subagentSnapshot` are not ported (model roles/subagents/predict-word are out of this
// slice's scope, `session::agent`'s own header).

use serde_json::Value;

use crate::omp::images::{validate_image_attachment, ImageValidationError};
use crate::session::agent::{
    classify_slash_invocation, is_chat_answer, parse_slash_command, SlashInvocationClassification,
};
use crate::session::SessionManager;

use super::{invalid_argument, not_found, AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("chat.send", chat_send);
    d.register("chat.stop", chat_stop);
    d.register("chat.removeQueued", chat_remove_queued);
    d.register("chat.sendNow", chat_send_now);
    d.register("chat.answer", chat_answer);
    d.register("chat.commands", chat_commands);
}

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
        if let Err(err) = validate_image_attachment(&image) {
            let mime_type = image.get("mimeType").and_then(Value::as_str).unwrap_or("");
            return Err(match err {
                ImageValidationError::UnsupportedImageType => IpcError::new(
                    "unsupported-image-type",
                    format!("Unsupported image type: {mime_type}"),
                ),
                ImageValidationError::ByteSizeTooLarge => {
                    IpcError::new("image-too-large", "Image exceeds the 20 MiB limit")
                }
                // #771: a distinct message from the byte-size cap above -- a tiny file can still
                // declare an enormous pixel count in its header.
                ImageValidationError::PixelCountTooLarge => {
                    IpcError::new("image-too-large", "Image exceeds the maximum pixel count")
                }
            });
        }
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

// Issue #540: no `images` argument here at all -- OMP keeps the queued message's own images
// with it (`promote_queued_message` moves the existing message, attachments included, rather
// than reprocessing it, so a resend never needs images supplied by the caller).
pub fn chat_send_now(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(session_id) = args.first().and_then(Value::as_str) else {
            return Err(invalid_argument(
                "chat.sendNow expects (sessionId, text) strings",
            ));
        };
        let Some(text) = args.get(1).and_then(Value::as_str) else {
            return Err(invalid_argument(
                "chat.sendNow expects (sessionId, text) strings",
            ));
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
        let result = manager(&state)
            .get_or_create_agent(session_id)
            .send_now(text.to_string())
            .await
            .map_err(map_chat_error)?;
        Ok(result)
    })
}
