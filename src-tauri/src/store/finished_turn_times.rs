// "Show finished turn times" setting (#1250).
use serde_json::{Map, Value};

use super::{Settings, SettingsStore};

pub(super) const KEY: &str = "showFinishedTurnTimes";

/// Default `false`: an absent or non-boolean value reads as off.
pub(super) fn parse(object: &Map<String, Value>) -> bool {
    object.get(KEY).and_then(Value::as_bool).unwrap_or(false)
}

impl SettingsStore {
    /// `settings.setShowFinishedTurnTimes    (enabled)`: plain boolean.
    pub async fn set_show_finished_turn_times(
        &mut self,
        enabled: bool,
    ) -> std::io::Result<Settings> {
        let next = Settings {
            show_finished_turn_times: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}
