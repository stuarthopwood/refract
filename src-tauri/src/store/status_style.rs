// How the shared status icon draws a Session's state (Icons or Dots); child module of
// `settings.rs` for the size cap (#806).
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::{Settings, SettingsStore};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StatusStyle {
    Icons,
    Dots,
}

pub(super) const KEY: &str = "statusStyle";

/// Default `Icons`: an absent or malformed value reads as icons, never trusted.
pub(super) fn parse(object: &Map<String, Value>) -> StatusStyle {
    object
        .get(KEY)
        .and_then(|v| serde_json::from_value::<StatusStyle>(v.clone()).ok())
        .unwrap_or(StatusStyle::Icons)
}

pub(super) fn write(map: &mut Map<String, Value>, value: StatusStyle) {
    map.insert(KEY.to_string(), json!(value));
}

impl SettingsStore {
    /// Plain-replace setter.
    pub async fn set_status_style(&mut self, value: StatusStyle) -> std::io::Result<Settings> {
        let next = Settings {
            status_style: value,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}
