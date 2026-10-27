// Issue #1250 (spec 001 FR-119): Settings > Chat "Show finished turn times", the switch for the
// settled turn total under each turn. A child module of `settings.rs` (not inline there) to keep
// that file under this build's 600-line cap (issue #806), the same reason `animated_status_text.rs`
// was split out.
use serde_json::{Map, Value};

use super::{Settings, SettingsStore};

pub(super) const KEY: &str = "showFinishedTurnTimes";

/// Default `false`: an absent or non-boolean value reads as off.
pub(super) fn parse(object: &Map<String, Value>) -> bool {
    object.get(KEY).and_then(Value::as_bool).unwrap_or(false)
}

impl SettingsStore {
    /// `settings.setShowFinishedTurnTimes(enabled)`: plain boolean, the same shape
    /// `set_animated_status_text` uses.
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
