// "Summarise agent cards with the tiny model", split out for the file-size cap.
// Off only stops the two per-agent model calls; the card falls back to its plain-text heuristics.
use serde_json::{Map, Value};

use super::{Settings, SettingsStore};

pub(super) const KEY: &str = "summariseAgentCards";

/// Default `true`: an absent or non-boolean value reads as on.
pub(super) fn parse(object: &Map<String, Value>) -> bool {
    object.get(KEY).and_then(Value::as_bool).unwrap_or(true)
}

pub(super) fn write(map: &mut Map<String, Value>, enabled: bool) {
    map.insert(KEY.to_string(), Value::Bool(enabled));
}

impl SettingsStore {
    /// `settings.setSummariseAgentCards(enabled)`: plain boolean.
    pub async fn set_summarise_agent_cards(&mut self, enabled: bool) -> std::io::Result<Settings> {
        let next = Settings {
            summarise_agent_cards: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn an_absent_value_reads_as_on() {
        assert!(parse(&object(json!({}))));
    }

    #[test]
    fn a_non_boolean_value_reads_as_on() {
        assert!(parse(&object(json!({ KEY: "off" }))));
    }

    #[test]
    fn a_stored_boolean_is_kept() {
        assert!(!parse(&object(json!({ KEY: false }))));
        assert!(parse(&object(json!({ KEY: true }))));
    }

    #[tokio::test]
    async fn the_setter_persists_and_survives_a_reopen() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut store = SettingsStore::open(dir.path()).await.expect("open");
        assert!(store.get().summarise_agent_cards);
        let saved = store.set_summarise_agent_cards(false).await.expect("set");
        assert!(!saved.summarise_agent_cards);
        let reopened = SettingsStore::open(dir.path()).await.expect("reopen");
        assert!(!reopened.get().summarise_agent_cards);
    }
}
