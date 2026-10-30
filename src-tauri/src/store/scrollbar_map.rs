// Settings > Chat "Show scrollbar map" switch (#754).
use serde_json::{Map, Value};

use super::{Settings, SettingsStore};

pub(super) const KEY: &str = "showScrollbarMap";

/// Default `true`: an absent or non-boolean value reads as on.
pub(super) fn parse(object: &Map<String, Value>) -> bool {
    object.get(KEY).and_then(Value::as_bool).unwrap_or(true)
}

impl SettingsStore {
    /// Plain boolean setter.
    pub async fn set_show_scrollbar_map(&mut self, enabled: bool) -> std::io::Result<Settings> {
        let next = Settings {
            show_scrollbar_map: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}
