// Issue #1205 (FR-107): Settings > Sessions "Show the Agent stopped bar". A child module of
// `settings.rs` (not inline there) to keep that file under this build's 600-line cap (issue
// #806), the same reason `chat_width.rs` was split out. The setting only hides the bar (FR-105);
// it never changes FR-103/FR-104 (a stopped Session always opens history-only).
use serde_json::{Map, Value};

use super::{Settings, SettingsStore};

pub(super) const KEY: &str = "showAgentStoppedBar";

/// Default `true`: an absent or non-boolean value reads as on (data-model.md, FR-107).
pub(super) fn parse(object: &Map<String, Value>) -> bool {
    object.get(KEY).and_then(Value::as_bool).unwrap_or(true)
}

impl SettingsStore {
    /// `settings.setShowAgentStoppedBar(enabled)`: plain boolean, the same shape
    /// `set_show_context_usage_bar` uses.
    pub async fn set_show_agent_stopped_bar(&mut self, enabled: bool) -> std::io::Result<Settings> {
        let next = Settings {
            show_agent_stopped_bar: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}
