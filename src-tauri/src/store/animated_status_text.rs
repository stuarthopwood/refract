// "Animated status text" shimmer switch (#1242, #1210); split out for the file-size cap (#806).
use serde_json::{Map, Value};

use super::{Settings, SettingsStore};

pub(super) const KEY: &str = "animatedStatusText";

/// Default `true`: an absent or non-boolean value reads as on.
pub(super) fn parse(object: &Map<String, Value>) -> bool {
    object.get(KEY).and_then(Value::as_bool).unwrap_or(true)
}

impl SettingsStore {
    /// `settings.setAnimatedStatusText    (enabled)`: plain boolean.
    pub async fn set_animated_status_text(&mut self, enabled: bool) -> std::io::Result<Settings> {
        let next = Settings {
            animated_status_text: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}
