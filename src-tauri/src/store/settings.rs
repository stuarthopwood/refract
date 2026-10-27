// Port of `src/main/store/settings.ts`: holds `settings.json`, the single app-wide Settings row
// (data-model.md "settings.json", tasks.md T015). Milestone 1 only exposes `settings.get` and
// `settings.setApprovalMode` over IPC (`parity.md`); every other setter below is still a full,
// faithful port (T015's own "Settings CRUD" scope) so a later slice's IPC registration is a
// one-line `dispatcher.register(...)` away, not a second pass over this file.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::atomic_json::write_json_file;
pub use super::chat_width::ChatWidth;
pub use super::holiday_touches::HolidayTouches;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalMode {
    Ask,
    EditFreely,
    Auto,
}

// `ThemeId` extracted to `theme_id.rs` (issue #551 gate round 1, #806 ratchet -- see that
// file's own header comment): re-exported here so every existing caller keeps importing it
// from `crate::store::settings::ThemeId`, unchanged.
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
    #[serde(rename = "pull-request")]
    pub pull_request: bool,
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

/// #735 data-model.md: only the DIFFERENCE from each group's default is stored -- a Repository
/// id absent from `collapsed_repository_ids` is open (the default for a newly added Project),
/// and `archived_open` defaults `false`. De-duplicated and validated in
/// `parse_session_list_collapse` below.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListCollapse {
    pub collapsed_repository_ids: Vec<String>,
    pub archived_open: bool,
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
    /// Issue #1048 (Settings, Appearance "Holiday touches"): default `Full` -- see
    /// `HolidayTouches`'s own doc comment. No raw/lazy-correction tracking needed, the same
    /// plain-enum shape `chat_width` above uses.
    pub holiday_touches: HolidayTouches,
    /// Issue #526 (FR-111): the Session row Activity line's wording; default `Plain`.
    pub activity_text: ActivityText,
    pub transcript_display: TranscriptDisplaySettings,
    pub show_sample_data: bool,
    pub detect_image_paths_on_paste: bool,
    /// Issue #1082 (spec 004 FR-034): the 2px context usage bar; default on.
    pub show_context_usage_bar: bool,
    /// Issue #1205 (FR-107): the "Agent stopped" bar; default on (`agent_stopped_bar.rs`).
    pub show_agent_stopped_bar: bool,
    pub show_ai_credits: bool,
    /// Issue #1242 (FR-042): the shared status-text shimmer switch; default on.
    pub animated_status_text: bool,
    /// Issue #1246: code ligatures on the Code font; default on (`code_ligatures.rs`).
    pub code_ligatures: bool,
    /// Issue #1250 (FR-119): the settled turn total under each turn; default off.
    pub show_finished_turn_times: bool,
    /// #735 data-model.md: collapsed/expanded state for the session list's per-Repository
    /// groups and the cross-repository Archived group, the renderer's `session-list-store.ts`
    /// the sole writer (never raw/lazy-correction tracked -- see `set_session_list_collapse`).
    pub session_list_collapse: SessionListCollapse,
    pub pull_requests_list_width_px: i64,
    /// Spec 024 (#538): the right pane's open/width/panels/active tab; see `right_pane.rs`.
    pub right_pane: RightPaneState,
    /// Issue #772 (lane R6): the word-prediction ghost-text off switch -- Rust-only (Electron
    /// main-process features are frozen, epic #797), so this field has no TypeScript
    /// counterpart. Default `false`: the shared prediction daemon measured 463 MB private commit
    /// with two live Sessions (more than Electron's whole main process), starts lazily on the
    /// first `predict_word` call and is never otherwise probed to confirm it is reliably shared
    /// machine-wide rather than per-profile -- "default to OFF when the evidence is unclear"
    /// (per the issue's own decision rule).
    pub word_prediction_enabled: bool,
    /// Quality-gate correction (code review, 2026-10-14): Electron's `this.data` is an untyped
    /// JS object, so an unrecognised settings.json key rides along through every
    /// `{...this.data, ...}` spread into `settings.get`'s reply and every `settings:changed`
    /// broadcast with no code needed for it. `#[serde(flatten)]` reproduces that on the wire:
    /// every entry here is merged into the TOP-LEVEL serialised object (never nested under its
    /// own `"extra"` key), so a caller sees the exact same shape Electron's reply has. Never
    /// overlaps a known field above (`SettingsStore::open` excludes all twelve by name).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

// Small per-setting modules (issue #806 cap); see `settings_parse.rs` for the parse helpers.
#[path = "settings_parse.rs"]
mod settings_parse;
pub(crate) use settings_parse::sanitize_collapsed_repository_ids;
use settings_parse::{
    clamp_pull_requests_list_width_px, default_session_list_collapse, parse_session_list_collapse,
    parse_session_readout, parse_split_layout, PULL_REQUESTS_LIST_WIDTH_PX_DEFAULT,
};
#[path = "activity_text.rs"]
mod activity_text;
#[path = "agent_stopped_bar.rs"]
mod agent_stopped_bar;
#[path = "ai_credits.rs"]
mod ai_credits;
pub use activity_text::ActivityText;
#[path = "animated_status_text.rs"]
mod animated_status_text;
#[path = "code_ligatures.rs"]
mod code_ligatures;
#[path = "finished_turn_times.rs"]
mod finished_turn_times;
#[path = "transcript_display.rs"]
mod transcript_display;
pub use transcript_display::TranscriptDisplaySettings;
#[path = "right_pane.rs"]
pub(crate) mod right_pane;
use right_pane::RightPaneState;

pub struct SettingsStore {
    file: PathBuf,
    data: Settings,
    /// Quality-gate remediation (HIGH, ported verbatim from `settings.ts`): the exact,
    /// pre-correction `theme` value as it was actually in `settings.json` (`Some` once the
    /// developer has ever saved a theme choice, `None` for a missing key or an invalid/corrupt
    /// value). Kept separate from `data.theme` (always the corrected, in-memory value every
    /// reader needs) so an unrelated setter's own whole-row write (`persist_whole`) never
    /// silently persists the FR-013 in-memory correction to disk on the user's behalf -- only
    /// `set_theme` itself is allowed to turn this from `None`/stale into a real value.
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

        // No lazy-correction comment in `settings.ts` covers `approvalMode` itself (it is only
        // ever defaulted via the missing-file fallback, never corrected on a present-but-invalid
        // value) -- a hand-corrupted value here falls back to `ask`, a Rust-necessitated
        // adaptation: `ApprovalMode` is a real enum, unlike TS's unchecked `as ApprovalMode` cast.
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

        // Issue #1048: default `Full` -- a missing/malformed value is never trusted, the same
        // lazy-correction pattern `chat_width` above uses.
        let holiday_touches = object
            .get("holidayTouches")
            .and_then(|v| serde_json::from_value::<HolidayTouches>(v.clone()).ok())
            .unwrap_or(HolidayTouches::Full);
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
        let show_finished_turn_times = finished_turn_times::parse(&object);

        // Issue #772: default `false` -- see `Settings::word_prediction_enabled`'s own doc
        // comment for the memory-cost evidence behind that default.
        let word_prediction_enabled = object
            .get("wordPredictionEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        // #735 data-model.md: a missing/null key is the default (no migration needed, every
        // pre-#735 settings.json simply lacks this key); a present-but-malformed value resets
        // to the default rather than trusted, the same lazy-correction pattern every other
        // object-shaped field in this function uses.
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

        const KNOWN_FIELDS: [&str; 21] = [
            "version",
            "approvalMode",
            "sessionReadout",
            "split",
            "theme",
            "watermarkEnabled",
            "chatWidth",
            "holidayTouches",
            activity_text::KEY,
            "transcriptDisplay",
            "showSampleData",
            "detectImagePathsOnPaste",
            "showContextUsageBar",
            agent_stopped_bar::KEY,
            ai_credits::KEY,
            animated_status_text::KEY,
            code_ligatures::KEY,
            finished_turn_times::KEY,
            "wordPredictionEnabled",
            "sessionListCollapse",
            "pullRequestsListWidthPx",
            right_pane::KEY,
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
            holiday_touches,
            activity_text,
            transcript_display,
            show_sample_data,
            detect_image_paths_on_paste,
            show_context_usage_bar,
            show_agent_stopped_bar,
            show_ai_credits,
            animated_status_text,
            code_ligatures,
            show_finished_turn_times,
            word_prediction_enabled,
            session_list_collapse,
            pull_requests_list_width_px,
            right_pane,
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

    /// Issue #772 (gate-fix, perf): `chat.predictWord`/`.predictWordFeedback` read this on every
    /// keystroke-debounced call -- a plain bool read, never `get()`'s own whole-`Settings` clone.
    pub fn word_prediction_enabled(&self) -> bool {
        self.data.word_prediction_enabled
    }

    /// Mirrors `settings.ts`'s own `serialize`: every setter that persists the WHOLE row writes
    /// `raw_theme`/`raw_watermark_enabled`/`raw_show_sample_data` (the value exactly as it was
    /// last actually on disk), never `data`'s possibly lazily-corrected in-memory value -- an
    /// absent raw value omits that key entirely (the Rust equivalent of `JSON.stringify` dropping
    /// an `undefined` field), reproducing "no key written yet" on disk.
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
        map.insert(
            "holidayTouches".to_string(),
            json!(self.data.holiday_touches),
        );
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
        let turn_times = self.data.show_finished_turn_times;
        map.insert(finished_turn_times::KEY.to_string(), json!(turn_times));
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
        // Re-inserts every key captured at `open()` with no slot here, verbatim (never overwrites
        // a known key; `data.extra` excludes all twelve), so an unported setting survives every
        // save, and `settings.get`/`settings:changed` flatten it onto the wire too.
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

    /// `settings.setApprovalMode` (T031, FR-015, the one milestone-1 setter): persists the whole
    /// row via `persist_whole`. Returns this call's own written value, not a possibly-superseded
    /// shared read -- matches `settings.ts`'s own race-safety comment on every setter.
    pub async fn set_approval_mode(&mut self, mode: ApprovalMode) -> std::io::Result<Settings> {
        let next = Settings {
            approval_mode: mode,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    /// `settings.setReadoutVisibility(kind, visible)` (spec 004 FR-012 to FR-014): `kind` is one
    /// of the seven `ReadoutKind` string values; an unrecognised one is a no-op (the IPC handler
    /// that will eventually call this validates against the known set first, the same division of
    /// responsibility `settings.ts`'s own `READOUT_KINDS` guard uses).
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
            "pull-request" => readout.pull_request = visible,
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

    /// `settings.setSplit(layout)` (spec 005 FR-014/FR-015): persists the whole Split layout (or
    /// `None` for no split).
    pub async fn set_split(&mut self, layout: Option<SplitLayout>) -> std::io::Result<Settings> {
        let next = Settings {
            split: layout,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    /// `theme.set(themeId)` (spec 007 FR-004): the one and only place allowed to turn `raw_theme`
    /// into a real, developer-saved value.
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

    /// `settings.setWatermarkEnabled(enabled)` (spec 012 FR-015 to FR-020): the one and only place
    /// allowed to turn `raw_watermark_enabled` into a real, developer-saved value.
    pub async fn set_watermark_enabled(&mut self, enabled: bool) -> std::io::Result<Settings> {
        self.raw_watermark_enabled = Some(enabled);
        let next = Settings {
            watermark_enabled: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    pub async fn set_chat_width(&mut self, width: ChatWidth) -> std::io::Result<Settings> {
        let next = Settings {
            chat_width: width,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    /// `settings.setHolidayTouches(value)` (issue #1048): plain-replace shape, as `set_chat_width`
    /// above uses -- no raw/lazy-correction tracking needed.
    pub async fn set_holiday_touches(
        &mut self,
        value: HolidayTouches,
    ) -> std::io::Result<Settings> {
        let next = Settings {
            holiday_touches: value,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    /// `settings.setTranscriptDisplay(field, visible)` (issue #457): merges ONE field into
    /// `transcript_display`, never a whole-object replace (a quick second toggle built from a
    /// stale value must not revert the first).
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

    /// `settings.setShowSampleData(enabled)` (spec 013 FR-020 to FR-022): the one and only place
    /// allowed to turn `raw_show_sample_data` into a real, developer-saved value.
    pub async fn set_show_sample_data(&mut self, enabled: bool) -> std::io::Result<Settings> {
        self.raw_show_sample_data = Some(enabled);
        let next = Settings {
            show_sample_data: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    /// `settings.setDetectImagePathsOnPaste(enabled)` (#514): no raw/lazy-correction tracking
    /// needed, the same plain-boolean migration shape `set_transcript_display` above uses.
    pub async fn set_detect_image_paths_on_paste(
        &mut self,
        enabled: bool,
    ) -> std::io::Result<Settings> {
        let next = Settings {
            detect_image_paths_on_paste: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    /// `settings.setWordPredictionEnabled(enabled)` (issue #772, lane R6): no raw/lazy-correction
    /// tracking needed, the same plain-boolean migration shape `set_detect_image_paths_on_paste`
    /// above uses.
    pub async fn set_word_prediction_enabled(
        &mut self,
        enabled: bool,
    ) -> std::io::Result<Settings> {
        let next = Settings {
            word_prediction_enabled: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    /// `settings.setSessionListCollapse(value)` (#735, data-model.md): persists the whole
    /// `SessionListCollapse` row -- the renderer's `session-list-store.ts` is the sole writer
    /// and never reads a broadcast back (its own doc comment explains why), so there is no
    /// raw/lazy-correction tracking here, the same plain-replace shape `set_split` uses.
    pub async fn set_session_list_collapse(
        &mut self,
        value: SessionListCollapse,
    ) -> std::io::Result<Settings> {
        let next = Settings {
            session_list_collapse: value,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    /// `settings.setPullRequestsListWidth(px)` (#930): plain-replace shape, as `set_split` uses.
    pub async fn set_pull_requests_list_width_px(
        &mut self,
        width_px: i64,
    ) -> std::io::Result<Settings> {
        let next = Settings {
            pull_requests_list_width_px: clamp_pull_requests_list_width_px(width_px),
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}

// Split into a sibling file (not inline here) only to keep this file comfortably under this
// build's 600-line-per-file cap once the full ported test suite (below) is included.
#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
