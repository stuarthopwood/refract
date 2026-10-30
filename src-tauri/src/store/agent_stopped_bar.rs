// "Show the Agent stopped bar" (#1205); split out for the file-size cap (#806).
// It only hides the bar; a stopped Session still opens history-only.
use serde_json::{Map, Value};

use super::{Settings, SettingsStore};

pub(super) const KEY: &str = "showAgentStoppedBar";

/// Default `true`: an absent or non-boolean value reads as on.
pub(super) fn parse(object: &Map<String, Value>) -> bool {
    object.get(KEY).and_then(Value::as_bool).unwrap_or(true)
}

impl SettingsStore {
    /// `settings.setShowAgentStoppedBar    (enabled)`: plain boolean.
    pub async fn set_show_agent_stopped_bar(&mut self, enabled: bool) -> std::io::Result<Settings> {
        let next = Settings {
            show_agent_stopped_bar: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}
