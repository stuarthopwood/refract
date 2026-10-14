// IPC handlers for `sideChat.*` (contracts/ipc.md "Side chat", spec 014) and
// `chat.predictWord`/`chat.predictWordFeedback`/`settings.setWordPredictionEnabled` (lane R6,
// issue #789; #772's word-prediction off switch, wired to the renderer's existing Settings
// screen/store) -- the IPC-facing sibling of `session/side_chat.rs`'s
// own frame handling and RPC calls. `ask`/`cancel`/`getHistory` all drive an already-attached
// process exactly like `chat.send`/`chat.stop` do, never a Conversation reattach, so
// `map_agent_error` (`ipc::mod`'s own `AgentError` -> `IpcError` mapper, shared by every other
// agent-backed channel) covers their failures the same way.

use serde_json::Value;

use crate::session::side_chat;

use super::{
    arg_str, invalid_argument, map_agent_error, not_found, AppState, Dispatcher, HandlerFuture,
    IpcError,
};

/// No OMP-documented limit exists for `btw`'s `question` field (`contracts/ipc.md` has no stated
/// maximum). 10,000 characters comfortably covers any realistic side question while still
/// bounding a pathological paste before it ever reaches OMP (main-side validation, Main's remit).
const MAX_QUESTION_LENGTH: usize = 10_000;
/// `recordId` is OMP's own opaque record id (observed live as a short hex string, FINDINGS item
/// 14); 200 characters is a generous upper bound that still catches a malformed/oversized value
/// before it reaches OMP.
const MAX_RECORD_ID_LENGTH: usize = 200;

pub fn register(d: &mut Dispatcher) {
    d.register("sideChat.ask", side_chat_ask);
    d.register("sideChat.cancel", side_chat_cancel);
    d.register("sideChat.getHistory", side_chat_get_history);
    d.register("chat.predictWord", chat_predict_word);
    d.register("chat.predictWordFeedback", chat_predict_word_feedback);
    d.register(
        "settings.setWordPredictionEnabled",
        settings_set_word_prediction_enabled,
    );
}

async fn session_exists(state: &AppState, session_id: &str) -> bool {
    state
        .registry
        .lock()
        .await
        .get_session(session_id)
        .is_some()
}

/// `sideChat.ask` (contracts/ipc.md "Side chat", spec 014 tasks.md T011-T013). A blank `question`
/// is rejected locally with `invalid-argument` before ever reaching OMP (one of `btw`'s own
/// documented failure cases); `recordId` omitted starts a fresh topic (FR-003), given, continues
/// one. These four messages reach the renderer's own toast verbatim -- plain English, never the
/// internal IPC channel name a developer never asked about.
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

/// `sideChat.cancel` (contracts/ipc.md): a no-op (not an error) if nothing is running -- mirrors
/// `subagents.cancel`'s own idempotent shape; `session::side_chat::cancel` itself no-ops with no
/// live process instead of returning an error.
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

/// `sideChat.getHistory` (contracts/ipc.md, FR-004): every side-chat record OMP has for this
/// Session's saved session file. Called once per Session per app run by the renderer store, not
/// polled. A Session with no live process yet still returns the `agent-not-running` error code
/// (not a silent empty list), so the store can retry once the Session actually starts.
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

/// `chat.predictWord` (T103, FR-058): ghost-text composer completion. Never rejects. Issue #772:
/// the off switch is checked HERE, before ever reaching the live process -- when disabled,
/// `predict_word` is never sent at all (best-effort, no visible error; the renderer already
/// treats `null` as "no suggestion").
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
        if !session_exists(&state, session_id).await {
            return Err(not_found(format!("Session not found: {session_id}")));
        }
        if !state.settings.lock().await.get().word_prediction_enabled {
            return Ok(Value::Null);
        }
        let agent = state.session_manager.get_or_create_agent(session_id);
        let suffix = side_chat::predict_word(&agent, text.to_string(), cursor).await;
        Ok(suffix.map(Value::String).unwrap_or(Value::Null))
    })
}

/// `chat.predictWordFeedback`: same silent-degradation contract as `chat.predictWord` above, and
/// the same off-switch gate.
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
        if !session_exists(&state, session_id).await {
            return Err(not_found(format!("Session not found: {session_id}")));
        }
        if !state.settings.lock().await.get().word_prediction_enabled {
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

/// `settings.setWordPredictionEnabled` (issue #772, Rust-only -- Electron main-process features
/// are frozen, so this setting has no TypeScript counterpart): persists the whole `Settings` row
/// and broadcasts `settings:changed`, the same pattern every other `settings.set*` setter uses
/// (`ipc::settings`). Registered here (not `ipc/settings.rs`, lane R8's own file) because the
/// underlying `word_prediction_enabled` field belongs to the `chat.predictWord*` prediction
/// feature lane R6 owns -- the channel string itself is under the generic `settings.*` namespace
/// to match every other setter's own naming (`settings.setWatermarkEnabled`, `.setShowSampleData`,
/// etc.), reusing the renderer's existing Settings screen/store (`ChatDisplaySection.tsx`,
/// `settings-store.ts`) rather than inventing a one-off UI surface for it.
pub fn settings_set_word_prediction_enabled(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(enabled) = args.first().and_then(Value::as_bool) else {
            return Err(invalid_argument(
                "settings.setWordPredictionEnabled expects a boolean enabled",
            ));
        };
        let value = state
            .settings
            .lock()
            .await
            .set_word_prediction_enabled(enabled)
            .await
            .map_err(|err| IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}
