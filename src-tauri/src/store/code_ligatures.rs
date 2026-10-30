// "Code ligatures" setting (#1246).
use serde_json::{Map, Value};

use super::{Settings, SettingsStore};

pub(super) const KEY: &str = "codeLigatures";

/// Default `true`: an absent or non-boolean value reads as on.
pub(super) fn parse(object: &Map<String, Value>) -> bool {
    object.get(KEY).and_then(Value::as_bool).unwrap_or(true)
}

impl SettingsStore {
    /// `settings.setCodeLigatures(enabled)`: plain boolean.
    pub async fn set_code_ligatures(&mut self, enabled: bool) -> std::io::Result<Settings> {
        let next = Settings {
            code_ligatures: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}
