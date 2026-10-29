// Issue #1300: Settings > Appearance "Chat row spacing", the gap between consecutive bookkeeping
// rows in the transcript. A child module of `settings.rs` to keep that file under the 600-line
// cap (issue #806).
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::{Settings, SettingsStore};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChatRowDensity {
    Tight,
    Compact,
    Comfy,
}

pub(super) const KEY: &str = "chatRowDensity";

/// Default `Compact`: an absent or malformed value reads as compact, never trusted.
pub(super) fn parse(object: &Map<String, Value>) -> ChatRowDensity {
    object
        .get(KEY)
        .and_then(|v| serde_json::from_value::<ChatRowDensity>(v.clone()).ok())
        .unwrap_or(ChatRowDensity::Compact)
}

pub(super) fn write(map: &mut Map<String, Value>, value: ChatRowDensity) {
    map.insert(KEY.to_string(), json!(value));
}

impl SettingsStore {
    /// `settings.setChatRowDensity(value)`: plain-replace shape, as `set_status_style` uses.
    pub async fn set_chat_row_density(&mut self, value: ChatRowDensity) -> std::io::Result<Settings> {
        let next = Settings {
            chat_row_density: value,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}
