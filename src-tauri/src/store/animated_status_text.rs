// Issue #1242 (spec 004 FR-042): Settings > Appearance "Animated status text", the switch for the
// shared status-text shimmer (also reused by #1210). A child module of `settings.rs` (not inline
// there) to keep that file under this build's 600-line cap (issue #806), the same reason
// `agent_stopped_bar.rs` was split out.
use serde_json::{Map, Value};

use super::{Settings, SettingsStore};

pub(super) const KEY: &str = "animatedStatusText";

/// Default `true`: an absent or non-boolean value reads as on.
pub(super) fn parse(object: &Map<String, Value>) -> bool {
    object.get(KEY).and_then(Value::as_bool).unwrap_or(true)
}

impl SettingsStore {
    /// `settings.setAnimatedStatusText(enabled)`: plain boolean, the same shape
    /// `set_show_agent_stopped_bar` uses.
    pub async fn set_animated_status_text(&mut self, enabled: bool) -> std::io::Result<Settings> {
        let next = Settings {
            animated_status_text: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}
