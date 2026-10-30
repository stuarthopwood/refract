// Settings "Activity text" (#526); split out of `settings.rs` for the file-size cap (#806).
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
    /// `settings.setActivityText(value)`: plain replace.
    pub async fn set_activity_text(&mut self, value: ActivityText) -> std::io::Result<Settings> {
        let next = Settings {
            activity_text: value,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}
