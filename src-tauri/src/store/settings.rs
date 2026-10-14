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
    /// Quality-gate correction (code review, 2026-10-14): Electron's `this.data` is an untyped
    /// JS object, so an unrecognised settings.json key rides along through every
    /// `{...this.data, ...}` spread into `settings.get`'s reply and every `settings:changed`
    /// broadcast with no code needed for it. `#[serde(flatten)]` reproduces that on the wire:
    /// every entry here is merged into the TOP-LEVEL serialised object (never nested under its
    /// own `"extra"` key), so a caller sees the exact same shape Electron's reply has. Never
    /// overlaps a known field above (`SettingsStore::open` excludes all nine by name).
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

        const KNOWN_FIELDS: [&str; 9] = [
            "version",
            "approvalMode",
            "sessionReadout",
            "split",
            "theme",
            "watermarkEnabled",
            "transcriptDisplay",
            "showSampleData",
            "detectImagePathsOnPaste",
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
        // Re-inserts every key captured at `open()` that this struct has no slot for, verbatim --
        // never overwrites a known key above (by construction, `data.extra` excludes all nine of
        // them), so a renderer feature's own not-yet-ported setting survives every save. Also now
        // the same field `settings.get`/`settings:changed` flatten into the wire shape (see
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
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Port of `store/settings.test.ts`'s own `openScratchStore`: a fresh, uniquely-named
    /// directory under the OS temp root, left on disk (never deleted), matching this project's
    /// existing scratch-directory test convention.
    async fn open_scratch_store(initial_json: Option<Value>) -> SettingsStore {
        let dir =
            std::env::temp_dir().join(format!("refract-settings-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir)
            .await
            .expect("create scratch dir");
        if let Some(json) = initial_json {
            tokio::fs::write(
                dir.join("settings.json"),
                serde_json::to_vec(&json).unwrap(),
            )
            .await
            .expect("write scratch settings.json");
        }
        SettingsStore::open(&dir).await.expect("open scratch store")
    }

    #[tokio::test]
    async fn transcript_display_defaults_on_a_brand_new_settings_json() {
        let store = open_scratch_store(None).await;
        assert!(store.get().transcript_display.thinking);
        assert!(store.get().transcript_display.tool_calls);
    }

    #[tokio::test]
    async fn transcript_display_fills_in_default_when_key_is_missing() {
        let store = open_scratch_store(Some(json!({
            "version": 1, "approvalMode": "ask", "sessionReadout": {}, "split": null,
            "theme": "dark", "watermarkEnabled": true
        })))
        .await;
        assert!(store.get().transcript_display.thinking);
        assert!(store.get().transcript_display.tool_calls);
    }

    #[tokio::test]
    async fn transcript_display_falls_back_to_default_on_malformed_shapes() {
        for malformed in [
            json!(5),
            json!("yes"),
            json!([]),
            json!({ "thinking": "yes" }),
            json!({ "thinking": true }),
            Value::Null,
        ] {
            let store = open_scratch_store(Some(json!({
                "version": 1, "approvalMode": "ask", "sessionReadout": {}, "split": null,
                "theme": "dark", "watermarkEnabled": true, "transcriptDisplay": malformed
            })))
            .await;
            assert!(store.get().transcript_display.thinking);
            assert!(store.get().transcript_display.tool_calls);
        }
    }

    #[tokio::test]
    async fn set_transcript_display_merges_one_field_without_touching_the_other() {
        let mut store = open_scratch_store(None).await;
        store
            .set_transcript_display("thinking", false)
            .await
            .unwrap();
        let after = store
            .set_transcript_display("toolCalls", false)
            .await
            .unwrap();
        assert!(!after.transcript_display.thinking);
        assert!(!after.transcript_display.tool_calls);
    }

    #[tokio::test]
    async fn set_transcript_display_is_idempotent_and_never_affects_the_other_field() {
        let mut store = open_scratch_store(None).await;
        store
            .set_transcript_display("toolCalls", false)
            .await
            .unwrap();
        let result = store
            .set_transcript_display("toolCalls", false)
            .await
            .unwrap();
        assert!(result.transcript_display.thinking);
        assert!(!result.transcript_display.tool_calls);
    }

    #[tokio::test]
    async fn set_transcript_display_persists_across_a_reopen() {
        let dir =
            std::env::temp_dir().join(format!("refract-settings-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let mut first = SettingsStore::open(&dir).await.unwrap();
        first
            .set_transcript_display("thinking", false)
            .await
            .unwrap();
        let reopened = SettingsStore::open(&dir).await.unwrap();
        assert!(!reopened.get().transcript_display.thinking);
        assert!(reopened.get().transcript_display.tool_calls);
    }

    /// Issue #791 acceptance: "unknown keys round-trip untouched so renderer features can add
    /// fields later (a Settings round-trip test)".
    #[tokio::test]
    async fn unknown_keys_round_trip_untouched_across_an_unrelated_setter_and_a_reopen() {
        let dir =
            std::env::temp_dir().join(format!("refract-settings-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(
            dir.join("settings.json"),
            serde_json::to_vec(&json!({
                "version": 1, "approvalMode": "ask", "sessionReadout": {}, "split": null,
                "theme": "dark", "watermarkEnabled": true, "aFutureFeature": { "enabled": true }
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        let mut store = SettingsStore::open(&dir).await.unwrap();
        store.set_show_sample_data(true).await.unwrap();

        let on_disk: Value =
            serde_json::from_slice(&tokio::fs::read(dir.join("settings.json")).await.unwrap())
                .unwrap();
        assert_eq!(
            on_disk.get("aFutureFeature"),
            Some(&json!({ "enabled": true }))
        );
        // The nine known fields are still written correctly alongside the unknown key, not
        // displaced by it.
        assert_eq!(on_disk.get("showSampleData"), Some(&json!(true)));
        assert_eq!(on_disk.get("approvalMode"), Some(&json!("ask")));

        // Quality-gate correction: `settings.get`'s own wire shape (what `serde_json::to_value`
        // produces for the IPC reply and every `settings:changed` broadcast) must ALSO carry the
        // unknown key -- `#[serde(flatten)]` on `Settings::extra` is what makes this true.
        let wire = serde_json::to_value(store.get()).unwrap();
        assert_eq!(
            wire.get("aFutureFeature"),
            Some(&json!({ "enabled": true }))
        );

        let reopened = SettingsStore::open(&dir).await.unwrap();
        assert!(reopened.get().show_sample_data);
    }
}
