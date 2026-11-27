// Opt-in Conversation retention (#2161, FR-189): `{ enabled, days }`; child module of `settings.rs`
// for the size cap (#806). Off by default: nothing is ever deleted unless the user turns it on.
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::{Settings, SettingsStore};

pub(super) const KEY: &str = "conversationRetention";
pub const MIN_DAYS: u32 = 1;
pub const MAX_DAYS: u32 = 3650;
pub const DEFAULT_DAYS: u32 = 90;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRetention {
    pub enabled: bool,
    pub days: u32,
}

impl Default for ConversationRetention {
    fn default() -> Self {
        Self {
            enabled: false,
            days: DEFAULT_DAYS,
        }
    }
}

pub fn clamp_days(days: u32) -> u32 {
    days.clamp(MIN_DAYS, MAX_DAYS)
}

/// Absent or malformed reads as the defaults, per field; a stored `days` is clamped into range.
pub(super) fn parse(object: &Map<String, Value>) -> ConversationRetention {
    let Some(inner) = object.get(KEY).and_then(Value::as_object) else {
        return ConversationRetention::default();
    };
    ConversationRetention {
        enabled: inner
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        days: inner
            .get("days")
            .and_then(Value::as_u64)
            .map_or(DEFAULT_DAYS, |days| {
                clamp_days(u32::try_from(days).unwrap_or(MAX_DAYS))
            }),
    }
}

pub(super) fn write(map: &mut Map<String, Value>, retention: ConversationRetention) {
    map.insert(KEY.to_string(), json!(retention));
}

impl SettingsStore {
    /// `settings.setConversationRetention({ enabled, days })`; `days` is clamped into range.
    pub async fn set_conversation_retention(
        &mut self,
        retention: ConversationRetention,
    ) -> std::io::Result<Settings> {
        let next = Settings {
            conversation_retention: ConversationRetention {
                enabled: retention.enabled,
                days: clamp_days(retention.days),
            },
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    async fn scratch_dir() -> std::path::PathBuf {
        let dir = crate::test_scratch::path(format!(
            "refract-conversation-retention-{}",
            uuid::Uuid::new_v4()
        ));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        dir
    }

    #[test]
    fn absent_or_malformed_reads_as_off_with_the_default_days() {
        let off = ConversationRetention::default();
        assert!(!off.enabled);
        assert_eq!(parse(&object(json!({}))), off);
        assert_eq!(parse(&object(json!({ KEY: "yes" }))), off);
        assert_eq!(
            parse(&object(json!({ KEY: { "enabled": "yes", "days": "x" } }))),
            off
        );
    }

    #[test]
    fn a_stored_value_is_read_and_days_are_clamped() {
        let read = |value: Value| parse(&object(json!({ KEY: value })));
        assert_eq!(
            read(json!({ "enabled": true, "days": 30 })),
            ConversationRetention {
                enabled: true,
                days: 30
            }
        );
        assert_eq!(read(json!({ "enabled": true, "days": 0 })).days, MIN_DAYS);
        assert_eq!(
            read(json!({ "enabled": true, "days": 99_999_999_999u64 })).days,
            MAX_DAYS
        );
        assert_eq!(
            read(json!({ "enabled": true, "days": -5 })).days,
            DEFAULT_DAYS
        );
    }

    #[tokio::test]
    async fn a_saved_retention_round_trips_and_a_known_key_never_leaks_into_extra() {
        let dir = scratch_dir().await;
        let mut store = SettingsStore::open(&dir).await.unwrap();
        assert_eq!(
            store.get().conversation_retention,
            ConversationRetention::default()
        );

        let saved = store
            .set_conversation_retention(ConversationRetention {
                enabled: true,
                days: 0,
            })
            .await
            .unwrap();
        assert_eq!(
            saved.conversation_retention,
            ConversationRetention {
                enabled: true,
                days: MIN_DAYS
            }
        );

        let reopened = SettingsStore::open(&dir).await.unwrap();
        assert_eq!(
            reopened.get().conversation_retention,
            saved.conversation_retention
        );
        assert_eq!(
            reopened.serialize_for_disk()[KEY],
            json!({ "enabled": true, "days": MIN_DAYS })
        );
        assert!(!reopened.get().extra.contains_key(KEY));
    }
}
