// Issue #1238 (spec 004 FR-053): Settings > Chat display "Show AI credits and plan usage". A
// child module of `settings.rs` (not inline there) to keep that file under this build's 600-line
// cap (issue #806). The setting only hides the credits part of the Context usage chip and stops
// the plan-usage lookup; it never changes the context percentage.
use serde_json::{json, Map, Value};

use super::{Settings, SettingsStore};

pub(super) const KEY: &str = "showAiCredits";

/// Default `true`: an absent or non-boolean value reads as on.
pub(super) fn parse(object: &Map<String, Value>) -> bool {
    object.get(KEY).and_then(Value::as_bool).unwrap_or(true)
}

pub(super) fn write(map: &mut Map<String, Value>, enabled: bool) {
    map.insert(KEY.to_string(), json!(enabled));
}

impl SettingsStore {
    /// `settings.setShowContextUsageBar(enabled)` (issue #1082): moved here from `settings.rs`
    /// unchanged to keep that file under the cap; same plain-boolean shape.
    pub async fn set_show_context_usage_bar(&mut self, enabled: bool) -> std::io::Result<Settings> {
        let next = Settings {
            show_context_usage_bar: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    /// `settings.setShowAiCredits(enabled)`: plain boolean, same shape as the other chat toggles.
    pub async fn set_show_ai_credits(&mut self, enabled: bool) -> std::io::Result<Settings> {
        let next = Settings {
            show_ai_credits: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}
