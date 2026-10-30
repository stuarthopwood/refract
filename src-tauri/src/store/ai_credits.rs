// "Show AI credits" (#1238); split out for the file-size cap (#806).
// Hides the chip and stops the plan-usage lookup; independent of the Context usage chip (#1268).
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
    /// `settings.setShowContextUsageBar    (enabled)` (#1082): plain boolean.
    pub async fn set_show_context_usage_bar(&mut self, enabled: bool) -> std::io::Result<Settings> {
        let next = Settings {
            show_context_usage_bar: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    /// `settings.setShowAiCredits(enabled)`: plain boolean.
    pub async fn set_show_ai_credits(&mut self, enabled: bool) -> std::io::Result<Settings> {
        let next = Settings {
            show_ai_credits: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}
