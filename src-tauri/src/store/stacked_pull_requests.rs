// "Stacked pull requests" setting (#1867).
use serde_json::{Map, Value};

use super::{Settings, SettingsStore};

pub(super) const KEY: &str = "stackedPullRequests";

/// Default `true`: an absent or non-boolean value reads as on.
pub(super) fn parse(object: &Map<String, Value>) -> bool {
    object.get(KEY).and_then(Value::as_bool).unwrap_or(true)
}

impl SettingsStore {
    /// `settings.setStackedPullRequests(enabled)`: plain boolean.
    pub async fn set_stacked_pull_requests(&mut self, enabled: bool) -> std::io::Result<Settings> {
        let next = Settings {
            stacked_pull_requests: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn scratch_dir() -> std::path::PathBuf {
        let dir =
            crate::test_scratch::path(format!("refract-stacked-prs-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir)
            .await
            .expect("create scratch dir");
        dir
    }

    #[test]
    fn parse_defaults_to_true_when_absent() {
        assert!(parse(&Map::new()));
    }

    #[test]
    fn parse_reads_an_explicit_false() {
        let object = json!({ KEY: false });
        assert!(!parse(object.as_object().unwrap()));
    }

    #[test]
    fn parse_treats_a_non_boolean_as_the_default_on() {
        for bad in [json!("false"), json!(0), json!(null), json!([]), json!({})] {
            let object = json!({ KEY: bad });
            assert!(parse(object.as_object().unwrap()), "{object}");
        }
    }

    #[tokio::test]
    async fn an_empty_settings_file_opens_with_the_setting_on() {
        let dir = scratch_dir().await;
        let store = SettingsStore::open(&dir).await.unwrap();
        assert!(store.get().stacked_pull_requests);
    }

    #[tokio::test]
    async fn false_persists_across_a_reopen_and_serialises_under_the_key() {
        let dir = scratch_dir().await;
        let mut store = SettingsStore::open(&dir).await.unwrap();
        let saved = store.set_stacked_pull_requests(false).await.unwrap();
        assert!(!saved.stacked_pull_requests);

        let reopened = SettingsStore::open(&dir).await.unwrap();
        assert!(!reopened.get().stacked_pull_requests);
        let wire = serde_json::to_value(reopened.get()).unwrap();
        assert_eq!(wire[KEY], json!(false));
        // A known key must never leak into the unrecognised-keys bag.
        assert!(!reopened.get().extra.contains_key(KEY));
    }
}
