// IPC handlers for `chat.*`. `.setVisibleSubagent` lives in `ipc/subagents.rs`.

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

const UNKNOWN_COMMAND_HINT: &str = "Type / to see the available commands.";

fn unknown_command_error(original_name: &str, rest: &str) -> IpcError {
    let suffix = if rest.is_empty() {
        String::new()
    } else {
        format!(" {rest}")
    };
    IpcError::new(
        "unknown-command",
        format!("Unknown command: /{original_name}{suffix}. {UNKNOWN_COMMAND_HINT}"),
    )
}

pub fn register(d: &mut Dispatcher) {
    d.register("chat.send", chat_send);
    d.register("chat.stop", chat_stop);
    d.register("chat.removeQueued", chat_remove_queued);
    d.register("chat.sendNow", chat_send_now);
    d.register("chat.answer", chat_answer);
    d.register("chat.commands", chat_commands);
}

/// Whether `name` is a Refract-native reserved command.
fn is_native_reserved(name: &str) -> bool {
    NATIVE_RESERVED_COMMANDS.contains(&name)
}

/// Whether `queue` is a queue kind OMP recognises.
fn is_valid_queue_kind(queue: &str) -> bool {
    queue == "followUp" || queue == "steering"
}

/// Rewrites `/model` to `/switch`, keeping the typed name for error messages.
/// Users must see "/model", never the internal "/switch".
fn rewrite_model_to_switch(name: String, rest: String) -> (String, String, String) {
    let original_name = name.clone();
    let name = if name == "model" {
        "switch".to_string()
    } else {
        name
    };
    (name, rest, original_name)
}

/// Extracts the `(sessionId, text)` positional pair, or `None` if malformed.
fn parse_session_id_and_text(args: &[Value]) -> Option<(&str, &str)> {
    let session_id = args.first()?.as_str()?;
    let text = args.get(1)?.as_str()?;
    Some((session_id, text))
}

fn manager(state: &AppState) -> &std::sync::Arc<SessionManager> {
    &state.session_manager
}

/// Maps a chat agent error straight through to its IPC error code.
fn map_chat_error(err: crate::session::AgentError) -> IpcError {
    IpcError::new(err.code, err.message)
}

/// Maps an image validation reason to its user-facing IPC error.
fn image_validation_ipc_error(err: ImageValidationError, mime_type: &str) -> IpcError {
    match err {
        ImageValidationError::UnsupportedImageType => IpcError::new(
            "unsupported-image-type",
            format!("Unsupported image type: {mime_type}"),
        ),
        ImageValidationError::ByteSizeTooLarge => {
            IpcError::new("image-too-large", "Image exceeds the 20 MiB limit")
        }
        // Separate from the byte cap: a tiny file can declare huge dimensions (#771).
        ImageValidationError::PixelCountTooLarge => {
            IpcError::new("image-too-large", "Image exceeds the maximum pixel count")
        }
    }
}

/// Shape-checks, then re-validates each image and builds a fresh `{type, data, mimeType}`.
/// Only those three fields are forwarded, so extra renderer fields never reach OMP.
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
        // Built from the validated fields only, never the caller's `entry`.
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
        super::sessions_lifecycle::delete_in_flight::refuse_if_deleting(session_id)?;
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
            // `/pause` toggles here; `/resume` stays OMP's own.
            if name == "pause" && rest.is_empty() {
                agent.toggle_pause().await.map_err(map_chat_error)?;
                return Ok(serde_json::json!({ "queued": false }));
            }
            // `/model` is a Refract-side rewrite to `/switch`; OMP's `model` opens its own role hub.
            let (name, rest, original_name) = rewrite_model_to_switch(name, rest);
            // `/role <role>` is Refract-native and validates against the wider chat-role set.
            // Bare `/role` falls through to the reserved-command refusal below.
            if name == "role" && !rest.is_empty() {
                let known_roles = model::known_chat_role_list()
                    .await
                    .map_err(map_chat_error)?;
                // `chat.send` returns only `{ queued }`; the richer `{model, role}` is for `ipc::model`.
                model::apply_role(&agent, &rest, &known_roles)
                    .await
                    .map_err(map_chat_error)?;
                return Ok(serde_json::json!({ "queued": false }));
            }
            // Refused locally, never forwarded to OMP, even if OMP later adds one of these.
            if is_native_reserved(name.as_str()) {
                return Err(unknown_command_error(&original_name, &rest));
            }
            // Waits for the first report after a start, so a queued command is checked against OMP's real list. (#1812)
            let commands = agent
                .wait_for_commands(crate::session::agent::COMMANDS_WAIT)
                .await;
            if commands.is_empty() {
                return Err(IpcError::new(
                    "commands-unavailable",
                    format!("The agent has not reported its commands yet, so /{original_name} was not sent. Try again in a moment."),
                ));
            }
            match classify_slash_invocation(&name, &rest, &commands) {
                SlashInvocationClassification::UnknownCommand => {
                    return Err(unknown_command_error(&original_name, &rest));
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
                        // `/switch` updates pin/role state and refreshes the composer label itself.
                        return model::handle_switch_text(&agent, &rest)
                            .await
                            .map_err(map_chat_error);
                    }
                    // Cancels any pending silent advisor probe so it cannot race this reply.
                    if name == "advisor" {
                        crate::session::advisor::cancel_pending_probe(&agent).await;
                    }
                    // Other OMP commands are forwarded as normal prompts below.
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
            .map_err(map_chat_error)
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
        let agent = manager(&state).get_or_create_agent(session_id);
        let mut commands = agent.available_commands().await;
        // A Session whose agent has not reported yet serves the last list OMP reported. (#1812)
        if commands.is_empty() {
            commands = crate::store::last_commands::load()
                .await
                .unwrap_or_default();
        }
        Ok(Value::Array(commands))
    })
}

// Resends keep their images: OMP moves the queued message, so no `images` argument is needed.
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
