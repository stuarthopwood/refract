// IPC handlers for `settings.*` (contracts/ipc.md "Settings", tasks.md T015/T028; remaining
// setters wired lane R8, issue #791). `settings.setApprovalMode` persists the mode and
// broadcasts `settings:changed` (T028, port of `ipc/broadcast.ts`'s own
// `broadcastSettingsChanged`) so every window stays in sync even for a caller that reaches this
// channel directly instead of through the renderer store's own self-updating action. Not ported
// (`session::agent`'s own header): fanning `pendingMode` out to every LIVE Session and restarting
// each at its own next settle (`SessionManager.applyPendingModeChange`/`SessionAgent.restart`,
// T031/T032) -- this build has no `restart()`, so an already-running Session keeps its OLD mode
// until the next time it is stopped and reopened; only a Session started (or restarted by this
// channel in the Electron build) AFTER this call picks up the new mode. Every other setter below
// is a direct port of `src/main/ipc/settings.ts`'s own basic-shape-validation-then-persist
// pattern: a malformed argument is `invalid-argument`, a valid one is persisted via
// `store::settings::SettingsStore` and broadcast the same way.

use serde_json::Value;

use crate::store::settings::{ApprovalMode, SplitLayout};

use super::{arg_str, invalid_argument, AppState, Dispatcher, HandlerFuture};

pub fn register(d: &mut Dispatcher) {
    d.register("settings.get", settings_get);
    d.register("settings.setApprovalMode", settings_set_approval_mode);
    d.register(
        "settings.setReadoutVisibility",
        settings_set_readout_visibility,
    );
    d.register("settings.setSplit", settings_set_split);
    d.register(
        "settings.setWatermarkEnabled",
        settings_set_watermark_enabled,
    );
    d.register(
        "settings.setTranscriptDisplay",
        settings_set_transcript_display,
    );
    d.register("settings.setShowSampleData", settings_set_show_sample_data);
    d.register(
        "settings.setDetectImagePathsOnPaste",
        settings_set_detect_image_paths_on_paste,
    );
    // Issue #772, lane R6: the underlying `word_prediction_enabled` field belongs to the
    // `chat.predictWord*` prediction feature lane R6 owns, but the channel itself follows every
    // other `settings.set*` channel's own naming -- registered here (not `side_chat.rs`) to keep
    // every `settings.*` channel in one place, same reasoning `ipc/mod.rs`'s own module split
    // documents for every other per-area file.
    d.register(
        "settings.setWordPredictionEnabled",
        settings_set_word_prediction_enabled,
    );
}

pub fn settings_get(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let settings = state.settings.lock().await.get();
        Ok(serde_json::to_value(settings).expect("Settings is always JSON-serialisable"))
    })
}

pub fn settings_set_approval_mode(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let mode = match args
            .first()
            .and_then(|v| v.as_str())
            .and_then(parse_approval_mode)
        {
            Some(mode) => mode,
            None => {
                return Err(invalid_argument(
                    "settings.setApprovalMode expects one of 'ask' | 'edit-freely' | 'auto'",
                ))
            }
        };
        let value = state
            .settings
            .lock()
            .await
            .set_approval_mode(mode)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}

fn parse_approval_mode(value: &str) -> Option<ApprovalMode> {
    serde_json::from_value(Value::String(value.to_string())).ok()
}

/// Spec 004 FR-012 to FR-014: the seven known `ReadoutKind` values; an unrecognised one is
/// `invalid-argument` here (the store's own `set_readout_visibility` additionally no-ops on one,
/// a second, independent layer).
const READOUT_KINDS: [&str; 7] = [
    "changes",
    "context-usage",
    "turn-time",
    "current-time",
    "pull-request",
    "subagents",
    "todo-progress",
];

fn require_bool(
    args: &[Value],
    index: usize,
    channel: &str,
    label: &str,
) -> Result<bool, super::IpcError> {
    match args.get(index).and_then(Value::as_bool) {
        Some(value) => Ok(value),
        None => Err(invalid_argument(format!(
            "{channel} expects a boolean {label}"
        ))),
    }
}

pub fn settings_set_readout_visibility(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let kind = match arg_str(&args, 0) {
            Some(kind) if READOUT_KINDS.contains(&kind) => kind.to_string(),
            _ => {
                return Err(invalid_argument(
                    "settings.setReadoutVisibility expects a known ReadoutKind",
                ))
            }
        };
        let visible = require_bool(&args, 1, "settings.setReadoutVisibility", "visible")?;
        let value = state
            .settings
            .lock()
            .await
            .set_readout_visibility(&kind, visible)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}

/// Spec 005 contracts/ipc.md `settings.setSplit`: basic-shape validation only, mirroring
/// `settings.ts`'s own quality-gate-remediated check -- `Value::Object` vs `Value::Array` are
/// already distinct `serde_json` variants (unlike JS's `typeof [] === 'object'`), so no separate
/// array rejection is needed; every field is read by direct key lookup and only a freshly-built
/// `SplitLayout` is ever persisted, never the caller's own object verbatim.
const SPLIT_NOT_OBJECT_MESSAGE: &str = "settings.setSplit expects a SplitLayout or null";
const SPLIT_SHAPE_MESSAGE: &str = "settings.setSplit expects { sessionIds: [string, string] (distinct), dividerPercent: 0-100, focusedIndex: 0 | 1 } or null";

fn parse_split_arg(value: &Value) -> Result<Option<SplitLayout>, super::IpcError> {
    if value.is_null() {
        return Ok(None);
    }
    let object = match value.as_object() {
        Some(object) => object,
        None => return Err(invalid_argument(SPLIT_NOT_OBJECT_MESSAGE)),
    };
    let session_ids = object.get("sessionIds").and_then(Value::as_array);
    let first = session_ids
        .and_then(|ids| ids.first())
        .and_then(Value::as_str);
    let second = session_ids
        .and_then(|ids| ids.get(1))
        .and_then(Value::as_str);
    let valid_session_ids = session_ids.is_some_and(|ids| ids.len() == 2)
        && first.is_some()
        && second.is_some()
        && first != second;
    let divider_percent = object.get("dividerPercent").and_then(Value::as_f64);
    let valid_divider_percent =
        divider_percent.is_some_and(|d| d.is_finite() && (0.0..=100.0).contains(&d));
    let focused_index = object.get("focusedIndex").and_then(Value::as_i64);
    let valid_focused_index = matches!(focused_index, Some(0) | Some(1));
    if !valid_session_ids || !valid_divider_percent || !valid_focused_index {
        return Err(invalid_argument(SPLIT_SHAPE_MESSAGE));
    }
    Ok(Some(SplitLayout {
        session_ids: [first.unwrap().to_string(), second.unwrap().to_string()],
        divider_percent: divider_percent.unwrap(),
        focused_index: focused_index.unwrap() as u8,
    }))
}

pub fn settings_set_split(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let layout = parse_split_arg(args.first().unwrap_or(&Value::Null))?;
        let value = state
            .settings
            .lock()
            .await
            .set_split(layout)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}

pub fn settings_set_watermark_enabled(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let enabled = require_bool(&args, 0, "settings.setWatermarkEnabled", "enabled")?;
        let value = state
            .settings
            .lock()
            .await
            .set_watermark_enabled(enabled)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}

/// Issue #457: `field` is one of the two known `TranscriptDisplaySettings` keys, validated here
/// (`invalid-argument` for anything else) before ever reaching the store's own per-field merge.
pub fn settings_set_transcript_display(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let field = match arg_str(&args, 0) {
            Some(field @ ("thinking" | "toolCalls")) => field.to_string(),
            _ => {
                return Err(invalid_argument(
                    "settings.setTranscriptDisplay expects field 'thinking' | 'toolCalls'",
                ))
            }
        };
        let visible = require_bool(&args, 1, "settings.setTranscriptDisplay", "visible")?;
        let value = state
            .settings
            .lock()
            .await
            .set_transcript_display(&field, visible)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}

pub fn settings_set_show_sample_data(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let enabled = require_bool(&args, 0, "settings.setShowSampleData", "enabled")?;
        let value = state
            .settings
            .lock()
            .await
            .set_show_sample_data(enabled)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}

pub fn settings_set_detect_image_paths_on_paste(
    state: AppState,
    args: Vec<Value>,
) -> HandlerFuture {
    Box::pin(async move {
        let enabled = require_bool(&args, 0, "settings.setDetectImagePathsOnPaste", "enabled")?;
        let value = state
            .settings
            .lock()
            .await
            .set_detect_image_paths_on_paste(enabled)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}

/// `settings.setWordPredictionEnabled` (issue #772, Rust-only -- no Electron implementation):
/// persists the whole `Settings` row and broadcasts `settings:changed`, the same pattern every
/// other setter above uses; `ipc/side_chat.rs`'s own `chat.predictWord`/`.predictWordFeedback`
/// read `store::settings::SettingsStore::word_prediction_enabled()` to gate before ever reaching
/// a live process.
pub fn settings_set_word_prediction_enabled(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let enabled = require_bool(&args, 0, "settings.setWordPredictionEnabled", "enabled")?;
        let value = state
            .settings
            .lock()
            .await
            .set_word_prediction_enabled(enabled)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn require_bool_accepts_true_and_false_rejects_non_bool_and_missing() {
        assert!(require_bool(
            &[Value::Bool(true)],
            0,
            "settings.setWatermarkEnabled",
            "enabled"
        )
        .unwrap());
        assert!(!require_bool(
            &[Value::Bool(false)],
            0,
            "settings.setWatermarkEnabled",
            "enabled"
        )
        .unwrap());
        assert!(require_bool(
            &[Value::String("yes".into())],
            0,
            "settings.setWatermarkEnabled",
            "enabled"
        )
        .is_err());
        assert!(require_bool(&[], 0, "settings.setWatermarkEnabled", "enabled").is_err());
    }

    #[test]
    fn parse_split_arg_accepts_null_and_a_valid_layout() {
        assert!(parse_split_arg(&Value::Null).unwrap().is_none());
        let valid = serde_json::json!({ "sessionIds": ["a", "b"], "dividerPercent": 50.0, "focusedIndex": 0 });
        let layout = parse_split_arg(&valid).unwrap().unwrap();
        assert_eq!(layout.session_ids, ["a".to_string(), "b".to_string()]);
        assert_eq!(layout.divider_percent, 50.0);
        assert_eq!(layout.focused_index, 0);
    }

    #[test]
    fn parse_split_arg_rejects_a_non_object_with_the_short_message() {
        let err = parse_split_arg(&Value::String("nope".into())).unwrap_err();
        assert_eq!(err.message, SPLIT_NOT_OBJECT_MESSAGE);
        let err = parse_split_arg(&serde_json::json!([])).unwrap_err();
        assert_eq!(err.message, SPLIT_NOT_OBJECT_MESSAGE);
    }

    #[test]
    fn parse_split_arg_rejects_malformed_fields_with_the_long_shape_message() {
        let duplicate_ids = serde_json::json!({ "sessionIds": ["a", "a"], "dividerPercent": 50.0, "focusedIndex": 0 });
        let err = parse_split_arg(&duplicate_ids).unwrap_err();
        assert_eq!(err.message, SPLIT_SHAPE_MESSAGE);

        let out_of_range = serde_json::json!({ "sessionIds": ["a", "b"], "dividerPercent": 150.0, "focusedIndex": 0 });
        assert!(parse_split_arg(&out_of_range).is_err());

        let bad_focused_index = serde_json::json!({ "sessionIds": ["a", "b"], "dividerPercent": 50.0, "focusedIndex": 2 });
        assert!(parse_split_arg(&bad_focused_index).is_err());
    }
}
