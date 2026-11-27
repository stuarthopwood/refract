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

    async fn scratch_dir() -> std::path::PathBuf {
        let dir =
            crate::test_scratch::path(format!("refract-reduce-motion-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir)
            .await
            .expect("create scratch dir");
        dir
    }

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn absent_reads_as_follow_the_os() {
        assert!(!parse(&object(json!({}))));
    }

    #[test]
    fn parse_reads_true_and_treats_non_booleans_as_off() {
        assert!(parse(&object(json!({ "reduceMotion": true }))));
        assert!(!parse(&object(json!({ "reduceMotion": "yes" }))));
        assert!(!parse(&object(json!({ "reduceMotion": 1 }))));
    }

    #[tokio::test]
    async fn true_persists_across_a_reopen_and_is_written_under_the_key() {
        let dir = scratch_dir().await;
        let mut store = SettingsStore::open(&dir).await.unwrap();
        assert!(!store.get().reduce_motion);
        let saved = store.set_reduce_motion(true).await.unwrap();
        assert!(saved.reduce_motion);

        let reopened = SettingsStore::open(&dir).await.unwrap();
        assert!(reopened.get().reduce_motion);
        assert_eq!(reopened.serialize_for_disk()[KEY], json!(true));
        let wire = serde_json::to_value(reopened.get()).unwrap();
        assert_eq!(wire[KEY], json!(true));
        // A known key must never leak into the unrecognised-keys bag.
        assert!(!reopened.get().extra.contains_key(KEY));
    }

    #[tokio::test]
    async fn turning_it_back_off_persists_false() {
        let dir = scratch_dir().await;
        let mut store = SettingsStore::open(&dir).await.unwrap();
        store.set_reduce_motion(true).await.unwrap();
        store.set_reduce_motion(false).await.unwrap();

        let reopened = SettingsStore::open(&dir).await.unwrap();
        assert!(!reopened.get().reduce_motion);
        assert_eq!(reopened.serialize_for_disk()[KEY], json!(false));
    }
}
