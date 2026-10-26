// Issue #526 (FR-111): Settings "Activity text", the Session row Activity line's wording style.
// A child module of `settings.rs` (not inline there) to keep that file under this build's 600-line
// cap (issue #806), the same reason `chat_width.rs` and `agent_stopped_bar.rs` were split out.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{Settings, SettingsStore};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActivityText {
    Plain,
    Playful,
}

pub(super) const KEY: &str = "activityText";

/// Default `Plain`: an absent or malformed value reads as plain, never trusted.
pub(super) fn parse(object: &Map<String, Value>) -> ActivityText {
    object
        .get(KEY)
        .and_then(|v| serde_json::from_value::<ActivityText>(v.clone()).ok())
        .unwrap_or(ActivityText::Plain)
}

impl SettingsStore {
    /// `settings.setActivityText(value)`: plain-replace shape, as `set_chat_width` uses.
    pub async fn set_activity_text(&mut self, value: ActivityText) -> std::io::Result<Settings> {
        let next = Settings {
            activity_text: value,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}
