// IPC handlers for `sideChat.*` and `chat.predictWord`/`chat.predictWordFeedback` (#789). They
// drive an already-attached process like `chat.send`, so `map_agent_error` covers failures.

use serde_json::Value;

use crate::session::side_chat;

use super::{
    arg_str, invalid_argument, map_agent_error, not_found, AppState, Dispatcher, HandlerFuture,
};

/// OMP documents no limit for `btw`'s `question`; 10,000 characters bounds a pathological paste
/// before it reaches OMP.
const MAX_QUESTION_LENGTH: usize = 10_000;
/// `recordId` is OMP's opaque record id (a short hex string); 200 characters catches a
/// malformed or oversized value.
const MAX_RECORD_ID_LENGTH: usize = 200;
/// Ghost-text `text` has no OMP limit either; it mirrors `MAX_QUESTION_LENGTH`.
const MAX_PREDICT_TEXT_LENGTH: usize = 10_000;

/// `cursor` is a UTF-16 offset into `text`; a negative or past-the-end value is not a caret.
fn validate_predict_cursor(text: &str, cursor: i64) -> Result<(), super::IpcError> {
    if text.len() > MAX_PREDICT_TEXT_LENGTH {
        return Err(invalid_argument(format!(
            "predictWord text must not exceed {MAX_PREDICT_TEXT_LENGTH} bytes"
        )));
    }
    let max_cursor = text.encode_utf16().count() as i64;
    if !(0..=max_cursor).contains(&cursor) {
        return Err(invalid_argument(
            "predictWord cursor must be a UTF-16 offset within text",
        ));
    }
    Ok(())
}

pub fn register(d: &mut Dispatcher) {
    d.register("sideChat.ask", side_chat_ask);
    d.register("sideChat.cancel", side_chat_cancel);
    d.register("sideChat.getHistory", side_chat_get_history);
    d.register("chat.predictWord", chat_predict_word);
    d.register("chat.predictWordFeedback", chat_predict_word_feedback);
}

async fn session_exists(state: &AppState, session_id: &str) -> bool {
    state
        .registry
        .lock()
        .await
        .get_session(session_id)
        .is_some()
}

/// `sideChat.ask`: a blank `question` is `invalid-argument`; `recordId` omitted starts a fresh
/// topic. The messages reach the renderer toast verbatim, so they stay plain English.
pub fn side_chat_ask(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        const SHAPE_MESSAGE: &str = "sideChat.ask expects (sessionId, question, recordId?) strings";
        let Some(session_id) = arg_str(&args, 0) else {
            return Err(invalid_argument(SHAPE_MESSAGE));
        };
        let Some(question) = arg_str(&args, 1) else {
            return Err(invalid_argument(SHAPE_MESSAGE));
        };
        let record_id = match args.get(2) {
            None | Some(Value::Null) => None,
            Some(Value::String(id)) => Some(id.clone()),
            Some(_) => return Err(invalid_argument(SHAPE_MESSAGE)),
        };
        if question.trim().is_empty() {
            return Err(invalid_argument("A side question must not be blank"));
        }
        if question.len() > MAX_QUESTION_LENGTH {
            return Err(invalid_argument(format!(
                "A side question must not exceed {MAX_QUESTION_LENGTH} characters"
            )));
        }
        if let Some(record_id) = &record_id {
            if record_id.is_empty() || record_id.len() > MAX_RECORD_ID_LENGTH {
                return Err(invalid_argument(format!(
                    "recordId must be 1-{MAX_RECORD_ID_LENGTH} characters when given"
                )));
            }
        }
        if !session_exists(&state, session_id).await {
            return Err(not_found(format!("Session not found: {session_id}")));
        }
        let agent = state.session_manager.get_or_create_agent(session_id);
        let result = side_chat::ask(&agent, question.to_string(), record_id)
            .await
            .map_err(map_agent_error)?;
        Ok(result)
    })
}

/// `sideChat.cancel`: a no-op, not an error, when nothing is running.
pub fn side_chat_cancel(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(session_id) = arg_str(&args, 0) else {
            return Err(invalid_argument(
                "Cancelling a side question needs a Session id",
            ));
        };
        if !session_exists(&state, session_id).await {
            return Err(not_found(format!("Session not found: {session_id}")));
        }
        let agent = state.session_manager.get_or_create_agent(session_id);
        side_chat::cancel(&agent).await.map_err(map_agent_error)?;
        Ok(Value::Null)
    })
}

/// `sideChat.getHistory`: every side-chat record OMP has for this Session. No live process
/// returns `agent-not-running`, not an empty list, so the store can retry.
pub fn side_chat_get_history(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(session_id) = arg_str(&args, 0) else {
            return Err(invalid_argument(
                "Loading side chat history needs a Session id",
            ));
        };
        if !session_exists(&state, session_id).await {
            return Err(not_found(format!("Session not found: {session_id}")));
        }
        let agent = state.session_manager.get_or_create_agent(session_id);
        let records = side_chat::history(&agent).await.map_err(map_agent_error)?;
        Ok(Value::Array(records))
    })
}

/// `chat.predictWord`: ghost-text completion; never rejects. The off switch is checked here, so
/// a disabled feature never sends `predict_word` (#772).
pub fn chat_predict_word(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        const SHAPE_MESSAGE: &str = "chat.predictWord expects (sessionId, text, cursor)";
        let Some(session_id) = arg_str(&args, 0) else {
            return Err(invalid_argument(SHAPE_MESSAGE));
        };
        let Some(text) = arg_str(&args, 1) else {
            return Err(invalid_argument(SHAPE_MESSAGE));
        };
        let Some(cursor) = args.get(2).and_then(Value::as_i64) else {
            return Err(invalid_argument(SHAPE_MESSAGE));
        };
        validate_predict_cursor(text, cursor)?;
        if !session_exists(&state, session_id).await {
            return Err(not_found(format!("Session not found: {session_id}")));
        }
        if !state.settings.lock().await.word_prediction_enabled() {
            return Ok(Value::Null);
        }
        let agent = state.session_manager.get_or_create_agent(session_id);
        let suffix = side_chat::predict_word(&agent, text.to_string(), cursor).await;
        Ok(suffix.map(Value::String).unwrap_or(Value::Null))
    })
}

/// `chat.predictWordFeedback`: same silent-degradation contract and off-switch gate.
pub fn chat_predict_word_feedback(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        const SHAPE_MESSAGE: &str =
            "chat.predictWordFeedback expects (sessionId, text, cursor, suggestion, accepted)";
        let Some(session_id) = arg_str(&args, 0) else {
            return Err(invalid_argument(SHAPE_MESSAGE));
        };
        let Some(text) = arg_str(&args, 1) else {
            return Err(invalid_argument(SHAPE_MESSAGE));
        };
        let Some(cursor) = args.get(2).and_then(Value::as_i64) else {
            return Err(invalid_argument(SHAPE_MESSAGE));
        };
        let Some(suggestion) = arg_str(&args, 3) else {
            return Err(invalid_argument(SHAPE_MESSAGE));
        };
        let Some(accepted) = args.get(4).and_then(Value::as_bool) else {
            return Err(invalid_argument(SHAPE_MESSAGE));
        };
        validate_predict_cursor(text, cursor)?;
        if !session_exists(&state, session_id).await {
            return Err(not_found(format!("Session not found: {session_id}")));
        }
        if !state.settings.lock().await.word_prediction_enabled() {
            return Ok(Value::Null);
        }
        let agent = state.session_manager.get_or_create_agent(session_id);
        side_chat::predict_word_feedback(
            &agent,
            text.to_string(),
            cursor,
            suggestion.to_string(),
            accepted,
        )
        .await;
        Ok(Value::Null)
    })
}
