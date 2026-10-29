// Issue #754 (spec 041): Settings > Chat "Show scrollbar map", the switch for the chat transcript's
// scrollbar map. A child module of `settings.rs` to keep that file under the 600-line cap (issue #806).
use serde_json::{Map, Value};

use super::{Settings, SettingsStore};

pub(super) const KEY: &str = "showScrollbarMap";

/// Default `true`: an absent or non-boolean value reads as on.
pub(super) fn parse(object: &Map<String, Value>) -> bool {
    object.get(KEY).and_then(Value::as_bool).unwrap_or(true)
}

impl SettingsStore {
    /// `settings.setShowScrollbarMap(enabled)`: plain boolean.
    pub async fn set_show_scrollbar_map(&mut self, enabled: bool) -> std::io::Result<Settings> {
        let next = Settings {
            show_scrollbar_map: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}
