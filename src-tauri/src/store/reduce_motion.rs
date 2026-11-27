// App-wide "Reduce motion" switch (#566, WCAG 2.2.2 pause path); split out for the file-size cap (#806).
use serde_json::{Map, Value};

use super::{Settings, SettingsStore};

pub(super) const KEY: &str = "reduceMotion";

/// Default `false` (follow the OS setting): an absent or non-boolean value reads as off.
pub(super) fn parse(object: &Map<String, Value>) -> bool {
    object.get(KEY).and_then(Value::as_bool).unwrap_or(false)
}

impl SettingsStore {
    /// `settings.setReduceMotion(enabled)`: plain boolean.
    pub async fn set_reduce_motion(&mut self, enabled: bool) -> std::io::Result<Settings> {
        let next = Settings {
            reduce_motion: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn absent_reads_as_follow_the_os() {
        assert!(!parse(&object(json!({}))));
    }

    #[test]
    fn true_persists_and_non_booleans_are_rejected() {
        assert!(parse(&object(json!({ "reduceMotion": true }))));
        assert!(!parse(&object(json!({ "reduceMotion": "yes" }))));
        assert!(!parse(&object(json!({ "reduceMotion": 1 }))));
    }
}
