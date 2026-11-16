// `settings.json` store: the single app-wide Settings row.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::atomic_json::write_json_file;
pub use super::chat_width::ChatWidth;
pub use super::holiday_touches::HolidayTouches;

pub use super::approval_mode::ApprovalMode;

// `ThemeId` lives in `theme_id.rs` (#806); re-exported so callers keep their import path.
pub use super::theme_id::ThemeId;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionReadout {
    pub changes: bool,
    #[serde(rename = "context-usage")]
    pub context_usage: bool,
    #[serde(rename = "turn-time")]
    pub turn_time: bool,
    #[serde(rename = "current-time")]
    pub current_time: bool,
    pub subagents: bool,
    #[serde(rename = "todo-progress")]
    pub todo_progress: bool,
    #[serde(rename = "current-work")]
    pub current_work: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitLayout {
    pub session_ids: [String; 2],
    pub divider_percent: f64,
    pub focused_index: u8,
}

/// Stores only the difference from the default: an id absent from `collapsed_repository_ids` is
/// open; `archived_open` defaults `false` (#735).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListCollapse {
    pub collapsed_repository_ids: Vec<String>,
    pub archived_open: bool,
    /// #748: the "Show hidden" toggle; absent in a pre-#748 file reads as `false`.
    #[serde(default)]
    pub show_hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub version: u8,
    pub approval_mode: ApprovalMode,
    pub session_readout: SessionReadout,
    pub split: Option<SplitLayout>,
    pub theme: ThemeId,
    pub watermark_enabled: bool,
    pub chat_width: ChatWidth,
    /// File id of the active custom theme (#458); `None` means the built-in `theme`.
    pub custom_theme: Option<String>,
    /// Default `Full` (#1048).
    pub holiday_touches: HolidayTouches,
    /// How the status icon draws a state; default `Icons` (#482).
    pub status_style: StatusStyle,
    /// Gap between bookkeeping rows; default `Compact` (#1300).
    pub chat_row_density: ChatRowDensity,
    /// Session row Activity line wording; default `Plain` (#526).
    pub activity_text: ActivityText,
    pub transcript_display: TranscriptDisplaySettings,
    pub show_sample_data: bool,
    pub detect_image_paths_on_paste: bool,
    /// The 2px context usage bar; default on (#1082).
    pub show_context_usage_bar: bool,
    /// The "Agent stopped" bar; default on (#1205).
    pub show_agent_stopped_bar: bool,
    /// AI credits chip beside the Context usage chip; default on, independent of it (#1238).
    pub show_ai_credits: bool,
    /// Status-text shimmer switch; default on (#1242).
    pub animated_status_text: bool,
    /// Code ligatures on the Code font; default on (#1246).
    pub code_ligatures: bool,
    /// Chat scrollbar map; default on (#754).
    pub show_scrollbar_map: bool,
    /// Settled turn total under each turn; default off (#1250).
    pub show_finished_turn_times: bool,
    /// Stacked pull requests via `gh stack`; default on (#1867).
    pub stacked_pull_requests: bool,
    /// Text size scales (`typography.rs`).
    pub typography: Typography,
    /// Collapsed/expanded state of session list groups; the renderer is the sole writer (#735).
    pub session_list_collapse: SessionListCollapse,
    pub pull_requests_list_width_px: i64,
    /// Right pane open/width/panels/active tab (`right_pane.rs`, #538).
    pub right_pane: RightPaneState,
    /// Word-prediction ghost-text switch; default `false` because the prediction daemon cost
    /// 463 MB with two Sessions (#772).
    pub word_prediction_enabled: bool,
    /// Default Clone from GitHub folder; `None` when unset (`default_clone_folder.rs`, #867).
    pub default_clone_folder: Option<String>,
    /// One-shot Alarms from the composer clock (`alarms.rs`, #1426).
    pub alarms: Vec<Alarm>,
    /// Sound on Session needs-you and finished OS notifications; default on (#1666).
    pub session_notification_sounds: bool,
    /// Looping sound on the alarm OS notification; default on (#1666).
    pub alarm_sounds: bool,
    /// Unrecognised keys, flattened into the top-level object; never overlaps a known field.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

// Per-setting modules (#806); parse helpers are in `settings_parse.rs`.
#[path = "settings_parse.rs"]
mod settings_parse;
pub(crate) use settings_parse::sanitize_collapsed_repository_ids;
use settings_parse::{
    clamp_pull_requests_list_width_px, default_session_list_collapse, parse_session_list_collapse,
    parse_session_readout, parse_split_layout, PULL_REQUESTS_LIST_WIDTH_PX_DEFAULT,
};
#[path = "activity_text.rs"]
mod activity_text;
#[path = "alarms.rs"]
mod alarms;
pub use alarms::Alarm;
#[path = "agent_stopped_bar.rs"]
mod agent_stopped_bar;
#[path = "ai_credits.rs"]
mod ai_credits;
pub use activity_text::ActivityText;
#[path = "status_style.rs"]
mod status_style;
pub use status_style::StatusStyle;
#[path = "chat_row_density.rs"]
mod chat_row_density;
pub use chat_row_density::ChatRowDensity;
#[path = "animated_status_text.rs"]
mod animated_status_text;
#[path = "code_ligatures.rs"]
mod code_ligatures;
#[path = "default_clone_folder.rs"]
mod default_clone_folder;
#[path = "finished_turn_times.rs"]
mod finished_turn_times;
#[path = "notification_sounds.rs"]
mod notification_sounds;
#[path = "scrollbar_map.rs"]
mod scrollbar_map;
#[path = "stacked_pull_requests.rs"]
mod stacked_pull_requests;
#[path = "typography.rs"]
mod typography;
pub use typography::Typography;
#[path = "transcript_display.rs"]
mod transcript_display;
pub use transcript_display::TranscriptDisplaySettings;
#[path = "right_pane.rs"]
pub(crate) mod right_pane;
#[path = "settings_setters.rs"]
mod settings_setters;
use right_pane::RightPaneState;

pub struct SettingsStore {
    file: PathBuf,
    data: Settings,
    /// The exact `theme` as on disk (`None` if missing or invalid), kept apart from the corrected
    /// `data.theme` so another setter's whole-row write never persists the correction.
    raw_theme: Option<ThemeId>,
    raw_watermark_enabled: Option<bool>,
    raw_show_sample_data: Option<bool>,
}

impl SettingsStore {
    pub async fn open(dir: &Path) -> std::io::Result<Self> {
        let file = dir.join("settings.json");
        let raw =
            super::atomic_json::read_json_file::<Value, _>(&file, || Value::Object(Map::new()))
                .await?;
        let object = raw.as_object().cloned().unwrap_or_default();

        // A corrupt value falls back to `ask`; `ApprovalMode` is a real enum.
        let approval_mode = object
            .get("approvalMode")
            .and_then(|v| serde_json::from_value::<ApprovalMode>(v.clone()).ok())
            .unwrap_or(ApprovalMode::Ask);

        let session_readout = parse_session_readout(object.get("sessionReadout"));

        let split = match object.get("split") {
            None | Some(Value::Null) => None,
            Some(v) => parse_split_layout(v),
        };

        let raw_theme = object
            .get("theme")
            .and_then(|v| serde_json::from_value::<ThemeId>(v.clone()).ok());
        let theme = raw_theme.unwrap_or(ThemeId::Dark);

        let raw_watermark_enabled = object.get("watermarkEnabled").and_then(Value::as_bool);
        let watermark_enabled = raw_watermark_enabled.unwrap_or(true);

        let chat_width = object
            .get("chatWidth")
            .and_then(|v| serde_json::from_value::<ChatWidth>(v.clone()).ok())
            .unwrap_or(ChatWidth::Full);

        let holiday_touches = super::holiday_touches::parse(&object);
        let status_style = status_style::parse(&object);
        let chat_row_density = chat_row_density::parse(&object);
        let activity_text = activity_text::parse(&object);
        let transcript_display = transcript_display::parse(&object);

        let raw_show_sample_data = object.get("showSampleData").and_then(Value::as_bool);
        let show_sample_data = raw_show_sample_data.unwrap_or(false);

        let detect_image_paths_on_paste = object
            .get("detectImagePathsOnPaste")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let show_context_usage_bar = object
            .get("showContextUsageBar")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let show_agent_stopped_bar = agent_stopped_bar::parse(&object);
        let show_ai_credits = ai_credits::parse(&object);
        let animated_status_text = animated_status_text::parse(&object);
        let code_ligatures = code_ligatures::parse(&object);
        let default_clone_folder = default_clone_folder::parse(&object);
        let alarms = alarms::parse(&object);
        let show_scrollbar_map = scrollbar_map::parse(&object);
        let session_notification_sounds = notification_sounds::parse_session(&object);
        let alarm_sounds = notification_sounds::parse_alarm(&object);
        let show_finished_turn_times = finished_turn_times::parse(&object);
        let stacked_pull_requests = stacked_pull_requests::parse(&object);
        let typography = typography::parse(&object);

        // Default `false`; see `Settings::word_prediction_enabled` for why (#772).
        let word_prediction_enabled = object
            .get("wordPredictionEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        // Missing or malformed resets to the default (#735).
        let session_list_collapse = match object.get("sessionListCollapse") {
            Some(v) if !v.is_null() => {
                parse_session_list_collapse(v).unwrap_or_else(default_session_list_collapse)
            }
            _ => default_session_list_collapse(),
        };
        // #930: one width for every Project; clamped rather than trusted.
        let pull_requests_list_width_px = object
            .get("pullRequestsListWidthPx")
            .and_then(Value::as_i64)
            .map(clamp_pull_requests_list_width_px)
            .unwrap_or(PULL_REQUESTS_LIST_WIDTH_PX_DEFAULT);
        let right_pane = right_pane::parse_from_disk(&object);

        let custom_theme = object
            .get("customTheme")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 48)
            .map(str::to_string);

        const KNOWN_FIELDS: [&str; 32] = [
            "customTheme",
            "version",
            "approvalMode",
            "sessionReadout",
            "split",
            "theme",
            "watermarkEnabled",
            "chatWidth",
            super::holiday_touches::KEY,
            status_style::KEY,
            chat_row_density::KEY,
            activity_text::KEY,
            "transcriptDisplay",
            "showSampleData",
            "detectImagePathsOnPaste",
            "showContextUsageBar",
            agent_stopped_bar::KEY,
            ai_credits::KEY,
            animated_status_text::KEY,
            code_ligatures::KEY,
            scrollbar_map::KEY,
            finished_turn_times::KEY,
            stacked_pull_requests::KEY,
            typography::KEY,
            "wordPredictionEnabled",
            "sessionListCollapse",
            "pullRequestsListWidthPx",
            right_pane::KEY,
            default_clone_folder::KEY,
            alarms::KEY,
            notification_sounds::SESSION_KEY,
            notification_sounds::ALARM_KEY,
        ];
        let extra: Map<String, Value> = object
            .iter()
            .filter(|(key, _)| !KNOWN_FIELDS.contains(&key.as_str()))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();

        let data = Settings {
            version: 1,
            approval_mode,
            session_readout,
            split,
            theme,
            watermark_enabled,
            chat_width,
            custom_theme,
            holiday_touches,
            status_style,
            chat_row_density,
            activity_text,
            transcript_display,
            show_sample_data,
            detect_image_paths_on_paste,
            show_context_usage_bar,
            show_agent_stopped_bar,
            show_ai_credits,
            animated_status_text,
            code_ligatures,
            show_scrollbar_map,
            show_finished_turn_times,
            stacked_pull_requests,
            typography,
            word_prediction_enabled,
            session_list_collapse,
            pull_requests_list_width_px,
            right_pane,
            default_clone_folder,
            alarms,
            session_notification_sounds,
            alarm_sounds,
            extra,
        };

        Ok(Self {
            file,
            data,
            raw_theme,
            raw_watermark_enabled,
            raw_show_sample_data,
        })
    }

    pub fn get(&self) -> Settings {
        self.data.clone()
    }

    /// Plain bool read for the per-keystroke prediction path, avoiding a whole-`Settings` clone (#772).
    pub fn word_prediction_enabled(&self) -> bool {
        self.data.word_prediction_enabled
    }

    /// Whole-row writes use the `raw_*` values as last on disk, not the corrected in-memory ones;
    /// an absent raw value omits its key.
    fn serialize_for_disk(&self) -> Value {
        let mut map = Map::new();
        map.insert("version".to_string(), json!(1));
        map.insert("approvalMode".to_string(), json!(self.data.approval_mode));
        map.insert(
            "sessionReadout".to_string(),
            json!(self.data.session_readout),
        );
        map.insert(
            "split".to_string(),
            match &self.data.split {
                Some(layout) => json!(layout),
                None => Value::Null,
            },
        );
        if let Some(theme) = self.raw_theme {
            map.insert("theme".to_string(), json!(theme));
        }
        if let Some(enabled) = self.raw_watermark_enabled {
            map.insert("watermarkEnabled".to_string(), json!(enabled));
        }
        map.insert("chatWidth".to_string(), json!(self.data.chat_width));
        map.insert("customTheme".to_string(), json!(self.data.custom_theme));
        super::holiday_touches::write(&mut map, self.data.holiday_touches);
        status_style::write(&mut map, self.data.status_style);
        chat_row_density::write(&mut map, self.data.chat_row_density);
        let activity_text = self.data.activity_text;
        map.insert(activity_text::KEY.to_string(), json!(activity_text));
        map.insert(
            "transcriptDisplay".to_string(),
            json!(self.data.transcript_display),
        );
        if let Some(enabled) = self.raw_show_sample_data {
            map.insert("showSampleData".to_string(), json!(enabled));
        }
        map.insert(
            "detectImagePathsOnPaste".to_string(),
            json!(self.data.detect_image_paths_on_paste),
        );
        map.insert(
            "showContextUsageBar".to_string(),
            json!(self.data.show_context_usage_bar),
        );
        let show_bar = self.data.show_agent_stopped_bar;
        map.insert(agent_stopped_bar::KEY.to_string(), json!(show_bar));
        ai_credits::write(&mut map, self.data.show_ai_credits);
        let animated = self.data.animated_status_text;
        map.insert(animated_status_text::KEY.to_string(), json!(animated));
        let ligatures = self.data.code_ligatures;
        map.insert(code_ligatures::KEY.to_string(), json!(ligatures));
        let scrollbar_map = self.data.show_scrollbar_map;
        map.insert(scrollbar_map::KEY.to_string(), json!(scrollbar_map));
        let turn_times = self.data.show_finished_turn_times;
        map.insert(finished_turn_times::KEY.to_string(), json!(turn_times));
        map.insert(
            stacked_pull_requests::KEY.to_string(),
            json!(self.data.stacked_pull_requests),
        );
        typography::write(&mut map, self.data.typography);
        map.insert(
            "wordPredictionEnabled".to_string(),
            json!(self.data.word_prediction_enabled),
        );
        map.insert(
            "sessionListCollapse".to_string(),
            json!(self.data.session_list_collapse),
        );
        map.insert(
            "pullRequestsListWidthPx".to_string(),
            json!(self.data.pull_requests_list_width_px),
        );
        map.insert(right_pane::KEY.to_string(), json!(self.data.right_pane));
        default_clone_folder::write(&mut map, &self.data.default_clone_folder);
        alarms::write(&mut map, &self.data.alarms);
        notification_sounds::write(
            &mut map,
            self.data.session_notification_sounds,
            self.data.alarm_sounds,
        );
        // Re-inserts keys captured at `open()` with no slot here, never overwriting a known key,
        // so unported settings survive every save and reach the wire.
        for (key, value) in &self.data.extra {
            map.insert(key.clone(), value.clone());
        }
        Value::Object(map)
    }

    async fn persist_whole(&mut self, next: Settings) -> std::io::Result<Settings> {
        self.data = next;
        write_json_file(&self.file, &self.serialize_for_disk()).await?;
        Ok(self.data.clone())
    }

    /// Persists the whole row; returns this call's own written value, not a shared read.
    pub async fn set_approval_mode(&mut self, mode: ApprovalMode) -> std::io::Result<Settings> {
        let next = Settings {
            approval_mode: mode,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    /// An unrecognised `kind` is a no-op; the IPC handler validates it first.
    pub async fn set_readout_visibility(
        &mut self,
        kind: &str,
        visible: bool,
    ) -> std::io::Result<Settings> {
        let mut readout = self.data.session_readout.clone();
        match kind {
            "changes" => readout.changes = visible,
            "context-usage" => readout.context_usage = visible,
            "turn-time" => readout.turn_time = visible,
            "current-time" => readout.current_time = visible,
            "subagents" => readout.subagents = visible,
            "todo-progress" => readout.todo_progress = visible,
            "current-work" => readout.current_work = visible,
            _ => return Ok(self.data.clone()),
        }
        let next = Settings {
            session_readout: readout,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    /// Persists the whole Split layout (`None` for no split).
    pub async fn set_split(&mut self, layout: Option<SplitLayout>) -> std::io::Result<Settings> {
        let next = Settings {
            split: layout,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    /// The only place allowed to turn `raw_theme` into a developer-saved value.
    pub async fn set_theme(&mut self, theme: ThemeId) -> std::io::Result<Settings> {
        let next = Settings {
            theme,
            ..self.data.clone()
        };
        self.data = next;
        self.raw_theme = Some(theme);
        write_json_file(&self.file, &self.serialize_for_disk()).await?;
        Ok(self.data.clone())
    }

    /// The only place allowed to turn `raw_watermark_enabled` into a developer-saved value.
    pub async fn set_watermark_enabled(&mut self, enabled: bool) -> std::io::Result<Settings> {
        self.raw_watermark_enabled = Some(enabled);
        let next = Settings {
            watermark_enabled: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    /// Merges ONE field into `transcript_display`, so a quick second toggle cannot revert the
    /// first (#457).
    pub async fn set_transcript_display(
        &mut self,
        field: &str,
        visible: bool,
    ) -> std::io::Result<Settings> {
        let mut transcript_display = self.data.transcript_display.clone();
        match field {
            "thinking" => transcript_display.thinking = visible,
            "toolCalls" => transcript_display.tool_calls = visible,
            "toolNames" => transcript_display.tool_names = visible,
            _ => return Ok(self.data.clone()),
        }
        let next = Settings {
            transcript_display,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    /// The only place allowed to turn `raw_show_sample_data` into a developer-saved value.
    pub async fn set_show_sample_data(&mut self, enabled: bool) -> std::io::Result<Settings> {
        self.raw_show_sample_data = Some(enabled);
        let next = Settings {
            show_sample_data: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}

// Tests live in a sibling file to keep this one under the size cap.
#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
