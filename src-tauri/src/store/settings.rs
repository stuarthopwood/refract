// Port of `src/main/store/settings.ts`: holds `settings.json`, the single app-wide Settings row
// (data-model.md "settings.json", tasks.md T015). Milestone 1 only exposes `settings.get` and
// `settings.setApprovalMode` over IPC (`parity.md`); every other setter below is still a full,
// faithful port (T015's own "Settings CRUD" scope) so a later slice's IPC registration is a
// one-line `dispatcher.register(...)` away, not a second pass over this file.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::atomic_json::write_json_file;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalMode {
    Ask,
    EditFreely,
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeId {
    Dark,
    DarkHighContrast,
    Obsidian,
}

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
}

/// Matches `src/shared/model.ts`'s own `DEFAULT_SESSION_READOUT` exactly, field for field.
fn default_session_readout() -> SessionReadout {
    SessionReadout {
        changes: true,
        context_usage: true,
        turn_time: true,
        current_time: false,
        pull_request: true,
        subagents: true,
        todo_progress: true,
    }
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
pub struct TranscriptDisplaySettings {
    pub thinking: bool,
    #[serde(rename = "toolCalls")]
    pub tool_calls: bool,
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
    pub transcript_display: TranscriptDisplaySettings,
    pub show_sample_data: bool,
    pub detect_image_paths_on_paste: bool,
    /// #735 data-model.md: collapsed/expanded state for the session list's per-Repository
    /// groups and the cross-repository Archived group, the renderer's `session-list-store.ts`
    /// the sole writer (never raw/lazy-correction tracked -- see `set_session_list_collapse`).
    pub session_list_collapse: SessionListCollapse,
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
    /// overlaps a known field above (`SettingsStore::open` excludes all eleven by name).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Spec 005 data-model.md "Validation"/"Migration": a present-but-malformed `split` (hand-edited,
/// or from a future/older build) is reset to `None` rather than trusted, the same lazy-correction
/// pattern `settings.ts`'s own `isValidSplitLayout` uses. Rejects a JSON array explicitly (`typeof
/// [] === 'object'` in JS let one slip through the old, weaker check) since `serde_json::Value`
/// distinguishes `Array` from `Object` directly.
fn parse_split_layout(value: &Value) -> Option<SplitLayout> {
    let object = value.as_object()?;
    let session_ids = object.get("sessionIds")?.as_array()?;
    if session_ids.len() != 2 {
        return None;
    }
    let first = session_ids[0].as_str()?;
    let second = session_ids[1].as_str()?;
    if first == second {
        return None;
    }
    let divider_percent = object.get("dividerPercent")?.as_f64()?;
    if !divider_percent.is_finite() || !(0.0..=100.0).contains(&divider_percent) {
        return None;
    }
    let focused_index = match object.get("focusedIndex")?.as_i64()? {
        0 => 0u8,
        1 => 1u8,
        _ => return None,
    };
    Some(SplitLayout {
        session_ids: [first.to_string(), second.to_string()],
        divider_percent,
        focused_index,
    })
}

/// #735 data-model.md: a present-but-malformed `sessionListCollapse` resets to the default
/// (`{ collapsedRepositoryIds: [], archivedOpen: false }`), the same lazy-correction pattern
/// `parse_split_layout` uses. De-duplicates `collapsedRepositoryIds` (a hand-edited file could
/// repeat an id).
fn default_session_list_collapse() -> SessionListCollapse {
    SessionListCollapse {
        collapsed_repository_ids: Vec::new(),
        archived_open: false,
    }
}

fn parse_session_list_collapse(value: &Value) -> Option<SessionListCollapse> {
    let object = value.as_object()?;
    let ids_value = object.get("collapsedRepositoryIds")?.as_array()?;
    let mut collapsed_repository_ids: Vec<String> = Vec::with_capacity(ids_value.len());
    for id in ids_value {
        let id = id.as_str()?;
        if !collapsed_repository_ids
            .iter()
            .any(|existing| existing == id)
        {
            collapsed_repository_ids.push(id.to_string());
        }
    }
    let archived_open = object.get("archivedOpen")?.as_bool()?;
    Some(SessionListCollapse {
        collapsed_repository_ids,
        archived_open,
    })
}

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

        let session_readout = object
            .get("sessionReadout")
            .and_then(Value::as_object)
            .map(|o| SessionReadout {
                changes: o.get("changes").and_then(Value::as_bool).unwrap_or(true),
                context_usage: o
                    .get("context-usage")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                turn_time: o.get("turn-time").and_then(Value::as_bool).unwrap_or(true),
                current_time: o
                    .get("current-time")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                pull_request: o
                    .get("pull-request")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                subagents: o.get("subagents").and_then(Value::as_bool).unwrap_or(true),
                todo_progress: o
                    .get("todo-progress")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
            })
            .unwrap_or_else(default_session_readout);

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

        let raw_transcript_display = object.get("transcriptDisplay").and_then(Value::as_object);
        let transcript_display = TranscriptDisplaySettings {
            thinking: raw_transcript_display
                .and_then(|o| o.get("thinking"))
                .and_then(Value::as_bool)
                .unwrap_or(true),
            tool_calls: raw_transcript_display
                .and_then(|o| o.get("toolCalls"))
                .and_then(Value::as_bool)
                .unwrap_or(true),
        };

        let raw_show_sample_data = object.get("showSampleData").and_then(Value::as_bool);
        let show_sample_data = raw_show_sample_data.unwrap_or(false);

        let detect_image_paths_on_paste = object
            .get("detectImagePathsOnPaste")
            .and_then(Value::as_bool)
            .unwrap_or(true);

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

        const KNOWN_FIELDS: [&str; 11] = [
            "version",
            "approvalMode",
            "sessionReadout",
            "split",
            "theme",
            "watermarkEnabled",
            "transcriptDisplay",
            "showSampleData",
            "detectImagePathsOnPaste",
            "wordPredictionEnabled",
            "sessionListCollapse",
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
            transcript_display,
            show_sample_data,
            detect_image_paths_on_paste,
            word_prediction_enabled,
            session_list_collapse,
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
            "wordPredictionEnabled".to_string(),
            json!(self.data.word_prediction_enabled),
        );
        map.insert(
            "sessionListCollapse".to_string(),
            json!(self.data.session_list_collapse),
        );
        // Re-inserts every key captured at `open()` that this struct has no slot for, verbatim --
        // never overwrites a known key above (by construction, `data.extra` excludes all eleven
        // of them), so a renderer feature's own not-yet-ported setting survives every save. Also
        // now the same field `settings.get`/`settings:changed` flatten into the wire shape (see
        // `Settings::extra`'s own doc comment).
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
}

// Split into a sibling file (not inline here) only to keep this file comfortably under this
// build's 600-line-per-file cap once the full ported test suite (below) is included.
#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
