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

use crate::store::settings::{
    ApprovalMode, ChatWidth, HolidayTouches, SessionListCollapse, SplitLayout,
};

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
        "settings.setShowContextUsageBar",
        settings_set_show_context_usage_bar,
    );
    d.register(
        "settings.setShowAgentStoppedBar",
        settings_set_show_agent_stopped_bar,
    );
    d.register(
        "settings.setWordPredictionEnabled",
        settings_set_word_prediction_enabled,
    );
    d.register(
        "settings.setSessionListCollapse",
        settings_set_session_list_collapse,
    );
    d.register(
        "settings.setPullRequestsListWidth",
        settings_set_pull_requests_list_width,
    );
    d.register("settings.setRightPane", settings_set_right_pane);
    d.register("settings.setChatWidth", settings_set_chat_width);
    d.register("settings.setHolidayTouches", settings_set_holiday_touches);
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

/// Spec 004 FR-012 to FR-014: the eight known `ReadoutKind` values; an unrecognised one is
/// `invalid-argument` here (the store's own `set_readout_visibility` additionally no-ops on one,
/// a second, independent layer).
const READOUT_KINDS: [&str; 8] = [
    "changes",
    "context-usage",
    "turn-time",
    "current-time",
    "pull-request",
    "subagents",
    "todo-progress",
    "current-work",
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

/// `settings.setChatWidth(width)` (issue #554, FR-073): same enum-parse-then-persist shape as
/// `settings_set_approval_mode` above.
pub fn settings_set_chat_width(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let width = match args
            .first()
            .and_then(|v| v.as_str())
            .and_then(parse_chat_width)
        {
            Some(width) => width,
            None => {
                return Err(invalid_argument(
                    "settings.setChatWidth expects one of 'full' | 'reading-column'",
                ))
            }
        };
        let value = state
            .settings
            .lock()
            .await
            .set_chat_width(width)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}

fn parse_chat_width(value: &str) -> Option<ChatWidth> {
    serde_json::from_value(Value::String(value.to_string())).ok()
}

/// `settings.setHolidayTouches(value)` (issue #1048): same enum-parse-then-persist shape as
/// `settings_set_chat_width` above.
pub fn settings_set_holiday_touches(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let value = match args
            .first()
            .and_then(|v| v.as_str())
            .and_then(parse_holiday_touches)
        {
            Some(value) => value,
            None => {
                return Err(invalid_argument(
                    "settings.setHolidayTouches expects one of 'full' | 'artwork' | 'off'",
                ))
            }
        };
        let value = state
            .settings
            .lock()
            .await
            .set_holiday_touches(value)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}

fn parse_holiday_touches(value: &str) -> Option<HolidayTouches> {
    serde_json::from_value(Value::String(value.to_string())).ok()
}

/// Issues #457 and #469: `field` is one of the three known `TranscriptDisplaySettings` keys,
/// validated here (`invalid-argument` for anything else) before ever reaching the store's own
/// per-field merge.
pub fn settings_set_transcript_display(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let field = match arg_str(&args, 0) {
            Some(field @ ("thinking" | "toolCalls" | "toolNames")) => field.to_string(),
            _ => {
                return Err(invalid_argument(
                    "settings.setTranscriptDisplay expects field 'thinking' | 'toolCalls' | 'toolNames'",
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

/// #735 contracts/ipc.md `settings.setSessionListCollapse`: basic-shape validation only --
/// `{ collapsedRepositoryIds: string[], archivedOpen: boolean }` -- plus the shared
/// `sanitize_collapsed_repository_ids` cap-and-dedupe pass (gate round 2 fix), mirroring
/// `parse_split_arg`'s own validate-then-persist pattern above. Ids are de-duplicated silently,
/// never rejected; an over-cap count or id length IS rejected as `invalid-argument`, since this
/// is the renderer's own validated write path, unlike the disk loader's lazy-correction.
const SESSION_LIST_COLLAPSE_SHAPE_MESSAGE: &str =
    "settings.setSessionListCollapse expects { collapsedRepositoryIds: string[], archivedOpen: boolean }";

fn parse_session_list_collapse_arg(value: &Value) -> Result<SessionListCollapse, super::IpcError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid_argument(SESSION_LIST_COLLAPSE_SHAPE_MESSAGE))?;
    let ids_value = object
        .get("collapsedRepositoryIds")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid_argument(SESSION_LIST_COLLAPSE_SHAPE_MESSAGE))?;
    let collapsed_repository_ids =
        crate::store::settings::sanitize_collapsed_repository_ids(ids_value)
            .ok_or_else(|| invalid_argument(SESSION_LIST_COLLAPSE_SHAPE_MESSAGE))?;
    let archived_open = object
        .get("archivedOpen")
        .and_then(Value::as_bool)
        .ok_or_else(|| invalid_argument(SESSION_LIST_COLLAPSE_SHAPE_MESSAGE))?;
    Ok(SessionListCollapse {
        collapsed_repository_ids,
        archived_open,
    })
}

pub fn settings_set_session_list_collapse(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let value = parse_session_list_collapse_arg(args.first().unwrap_or(&Value::Null))?;
        let value = state
            .settings
            .lock()
            .await
            .set_session_list_collapse(value)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}

/// #930 contracts/ipc.md `settings.setPullRequestsListWidth(px)`: one width for every Project,
/// clamped (not rejected) by `SettingsStore` itself, the same shape `settings.setTheme` would
/// use if it did not also track a raw value -- a plain-replace setter with no raw/lazy-correction
/// tracking needed.
pub fn settings_set_pull_requests_list_width(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let width_px = args.first().and_then(Value::as_i64).ok_or_else(|| {
            invalid_argument("settings.setPullRequestsListWidth expects a number of pixels")
        })?;
        let value = state
            .settings
            .lock()
            .await
            .set_pull_requests_list_width_px(width_px)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}

/// Spec 024 contracts/ipc.md `settings.setRightPane(value)` (#538): a malformed shape is
/// `invalid-argument`; width and the active tab are normalised by `right_pane::parse`.
pub fn settings_set_right_pane(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let parsed = args
            .first()
            .and_then(crate::store::settings::right_pane::parse)
            .ok_or_else(|| {
                invalid_argument(
                    "settings.setRightPane expects {open, widthPx, openPanelIds, activePanelId}",
                )
            })?;
        let value = state
            .settings
            .lock()
            .await
            .set_right_pane(parsed)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}

/// `settings.setShowContextUsageBar(enabled)` (issue #1082, spec 004 FR-034).
pub fn settings_set_show_context_usage_bar(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let enabled = require_bool(&args, 0, "settings.setShowContextUsageBar", "enabled")?;
        let value = state
            .settings
            .lock()
            .await
            .set_show_context_usage_bar(enabled)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}

/// `settings.setShowAgentStoppedBar(enabled)` (issue #1205, FR-107).
pub fn settings_set_show_agent_stopped_bar(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let enabled = require_bool(&args, 0, "settings.setShowAgentStoppedBar", "enabled")?;
        let value = state
            .settings
            .lock()
            .await
            .set_show_agent_stopped_bar(enabled)
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
