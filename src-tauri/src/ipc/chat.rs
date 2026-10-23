// IPC handlers for `chat.*` (contracts/ipc.md "Chat", tasks.md T026). Ports `chat.send`
// (including the native `/new` slash-command routing and the allowlisted-commands validation,
// `src/main/ipc/chat.ts`), `.stop`, `.answer`, `.removeQueued`, `.commands`, and `.sendNow`
// (issue #540, lane R4). `.predictWord`/`.predictWordFeedback` are not ported (model roles/
// predict-word are out of this slice's scope, `session::agent`'s own header).
// `.setVisibleSubagent`/`.subagentSnapshot` are ported, but in the sibling `ipc/subagents.rs`
// (lane R5, issue #788), not here.

use serde_json::{json, Value};

use crate::omp::images::{
    validate_image_attachment_decoded, validate_image_attachment_shape, ImageValidationError,
};
use crate::session::agent::{
    classify_slash_invocation, classify_unsupported_arguments, is_chat_answer, parse_slash_command,
    SlashInvocationClassification, SubcommandRefusal, NATIVE_RESERVED_COMMANDS,
};
use crate::session::{model, SessionManager};

use super::{invalid_argument, not_found, AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("chat.send", chat_send);
    d.register("chat.stop", chat_stop);
    d.register("chat.removeQueued", chat_remove_queued);
    d.register("chat.sendNow", chat_send_now);
    d.register("chat.answer", chat_answer);
    d.register("chat.commands", chat_commands);
}

/// Pure (gate-fix, testability): `name` is one of Refract's own native/reserved commands
/// (`session::agent::commands`'s own `NATIVE_RESERVED_COMMANDS`, the one shared copy).
fn is_native_reserved(name: &str) -> bool {
    NATIVE_RESERVED_COMMANDS.contains(&name)
}

/// Pure (gate-fix, testability): the only two queue values OMP's `remove_queued_message`/the
/// chip model recognise.
fn is_valid_queue_kind(queue: &str) -> bool {
    queue == "followUp" || queue == "steering"
}

/// `/model` is rewritten to `/switch` before classification or forwarding; everything else
/// passes through unchanged. Returns `(name, rest, original_name)` -- `original_name` is always
/// what the user actually typed, kept for every error message downstream (a user who typed
/// `/model` must see "/model", never the internal rewrite target "/switch").
fn rewrite_model_to_switch(name: String, rest: String) -> (String, String, String) {
    let original_name = name.clone();
    let name = if name == "model" {
        "switch".to_string()
    } else {
        name
    };
    (name, rest, original_name)
}

/// Pure (gate-fix, testability): the `(sessionId, text)` positional pair every `chat.send`/
/// `.sendNow` call needs, or `None` if either is missing or not a string.
fn parse_session_id_and_text(args: &[Value]) -> Option<(&str, &str)> {
    let session_id = args.first()?.as_str()?;
    let text = args.get(1)?.as_str()?;
    Some((session_id, text))
}

fn manager(state: &AppState) -> &std::sync::Arc<SessionManager> {
    &state.session_manager
}

/// Port of `chat.ts`'s own `mapChatError`: every `chat.send`/`.stop`/`.removeQueued` failure
/// maps straight through (`AgentError::code` already matches `src/shared/ipc.ts`'s own
/// `IpcErrorCode` values, same as `AgentNotRunningError`/`PromptFailedError`'s own `code` field).
fn map_chat_error(err: crate::session::AgentError) -> IpcError {
    IpcError::new(err.code, err.message)
}

/// Maps the omp::images classification to the exact message each reason gets at this call site
/// (shared by both the shape and the decoded validation failures below).
fn image_validation_ipc_error(err: ImageValidationError, mime_type: &str) -> IpcError {
    match err {
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
    }
}

/// Port of `chat.ts`'s own `parseImagesArgument`: shape-checks, then independently re-validates
/// every entry (FR-018) before ever building the outgoing `prompt` command. Gate-fix (Critical,
/// security): builds a FRESH `{ type: "image", data, mimeType }` object containing ONLY the
/// three validated fields, never the caller's whole object -- a compromised/buggy renderer could
/// otherwise attach extra fields (`providerFile`, `url`, `detail`) that OMP's own real handling
/// acts on, reaching a privileged provider-file/remote-URL fetch despite every shape/mime/size
/// check here passing (mirrors `chat.ts`'s own `parseImagesArgument`, lines 57-81). Gate-fix
/// (perf): `validate_image_attachment_shape` runs on the BORROWED `&str` first -- a mime-type or
/// over-declared-size rejection never pays for the clone the blocking-pool call below needs.
/// Only once shape passes does ownership of `data`/`mimeType` move into `spawn_blocking` (the
/// full base64 decode plus header walk is CPU work, not I/O, and a 20 MiB image's worth of it
/// should never run on an async executor thread); the same owned Strings come back out to build
/// the fresh entry above, so each image's text is copied exactly once. A `JoinError` (the
/// blocking task panicking on some input this parser itself cannot anticipate) is mapped to a
/// fail-closed `unsupported-image-type`, never an `.expect()` panic reaching the IPC caller.
async fn parse_images_argument(images: Option<&Value>) -> Result<Option<Vec<Value>>, IpcError> {
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
        let Some(mime_type) = candidate.get("mimeType").and_then(Value::as_str) else {
            return Err(invalid_argument(
                "chat.send: image mimeType must be a string",
            ));
        };
        if let Err(err) = validate_image_attachment_shape(data, mime_type) {
            return Err(image_validation_ipc_error(err, mime_type));
        }
        let data_owned = data.to_string();
        let mime_owned = mime_type.to_string();
        let (data_owned, mime_owned, validation) = tokio::task::spawn_blocking(move || {
            let result = validate_image_attachment_decoded(&data_owned, &mime_owned);
            (data_owned, mime_owned, result)
        })
        .await
        .map_err(|_join_err| {
            IpcError::new(
                "unsupported-image-type",
                "That image could not be validated; nothing was attached.",
            )
        })?;
        if let Err(err) = validation {
            return Err(image_validation_ipc_error(err, &mime_owned));
        }
        // Built fresh from only the three validated, owned fields -- see this function's own
        // doc comment; never the caller's original `entry`.
        parsed.push(json!({ "type": "image", "data": data_owned, "mimeType": mime_owned }));
    }
    Ok(Some(parsed))
}

pub fn chat_send(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some((session_id, text)) = parse_session_id_and_text(&args) else {
            return Err(invalid_argument(
                "chat.send expects (sessionId, text) strings",
            ));
        };
        let parsed_images = parse_images_argument(args.get(2)).await?;
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
            // Issue #762 (lane RM): `/model`/`/model <model>` are a Refract-side rewrite to
            // `/switch`/`/switch <model>`, before anything is classified or forwarded -- OMP's
            // own `model` builtin (alias `models`) opens the role-writing hub, never what
            // Refract's composer means by this name (FINDINGS item 53).
            let (name, rest, original_name) = rewrite_model_to_switch(name, rest);
            // Issue #766: `/role <role>` applies directly (Refract-native; no OMP command
            // exists for this). Bare `/role` has no server-side action (the renderer opens the
            // Ctrl+R selector) and falls through to the reserved-command refusal below, same as
            // `/btw`/`/models`. Validates against the WIDER chat-role set (gate-fix, round 4):
            // `cycleOrder` + `plan` + every other configured chat role, not only Ctrl+R's own
            // narrower cycling list (`model::known_role_list`, Stuart's own decided design).
            if name == "role" && !rest.is_empty() {
                let known_roles = model::known_chat_role_list()
                    .await
                    .map_err(map_chat_error)?;
                // Gate-fix (HIGH): `chat.send`'s own wire type is `Result<{ queued: boolean }>`
                // (ipc.ts); the richer `{model, role}` shape is for `ipc::model`'s own direct
                // `applyRole` caller only, never this text-command path.
                model::apply_role(&agent, &rest, &known_roles)
                    .await
                    .map_err(map_chat_error)?;
                return Ok(serde_json::json!({ "queued": false }));
            }
            // Port of `slash-commands.ts`'s own `NATIVE_RESERVED_COMMANDS` (chat.ts:125-130):
            // refused locally before classification, never forwarded to OMP even if a future
            // OMP version later recognizes one of these names as a real command.
            if is_native_reserved(name.as_str()) {
                let suffix = if rest.is_empty() {
                    String::new()
                } else {
                    format!(" {rest}")
                };
                return Err(IpcError::new(
                    "unknown-command",
                    format!("Unknown command: /{original_name}{suffix}"),
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
                        format!("Unknown command: /{original_name}{suffix}"),
                    ));
                }
                SlashInvocationClassification::UnsupportedArguments => {
                    let message = match classify_unsupported_arguments(&name, &rest, &commands) {
                        SubcommandRefusal::ExtraTextAfterSubcommand { subcommand } => {
                            format!("/{original_name} {subcommand} doesn't take more text yet. Try /{original_name} {subcommand} on its own.")
                        }
                        SubcommandRefusal::UnrecognisedSubcommand { verified }
                            if !verified.is_empty() =>
                        {
                            format!("/{original_name} takes one of: {}.", verified.join(", "))
                        }
                        SubcommandRefusal::UnrecognisedSubcommand { .. } => {
                            format!("/{original_name} doesn't support arguments yet. Try /{original_name} on its own.")
                        }
                    };
                    return Err(IpcError::new("unsupported-arguments", message));
                }
                SlashInvocationClassification::Supported => {
                    if name == "switch" {
                        // Issue #762: `/switch <arg>` (and its `/model` alias, rewritten above)
                        // tracks pinning/role state and refreshes the composer label itself --
                        // never the generic forward-and-ignore path every other supported OMP
                        // command below falls through to.
                        return model::handle_switch_text(&agent, &rest)
                            .await
                            .map_err(map_chat_error);
                    }
                    // Issue #937, gate round 2 fix (decided): the user is already driving
                    // `/advisor` themselves -- cancel any still-pending silent attach/resume
                    // probe (`session::advisor`'s own header) so it can never swallow or race
                    // this real, user-authored reply.
                    if name == "advisor" {
                        crate::session::advisor::cancel_pending_probe(&agent).await;
                    }
                    // Any other real OMP-side command (from `available_commands_update`): fall
                    // through and forward it as a normal prompt below.
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
        if !is_valid_queue_kind(queue) {
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
        let Some((session_id, text)) = parse_session_id_and_text(&args) else {
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

#[cfg(test)]
#[path = "chat.test.rs"]
mod tests;
