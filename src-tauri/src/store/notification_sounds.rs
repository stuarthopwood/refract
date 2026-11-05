// Settings > Notifications sound switches (#1666): Session notification sounds and Alarm sounds.
use serde_json::{json, Map, Value};

use super::{Settings, SettingsStore};

pub(super) const SESSION_KEY: &str = "sessionNotificationSounds";
pub(super) const ALARM_KEY: &str = "alarmSounds";

/// Default `true`: an absent or non-boolean value reads as on.
fn flag(object: &Map<String, Value>, key: &str) -> bool {
    object.get(key).and_then(Value::as_bool).unwrap_or(true)
}

pub(super) fn parse_session(object: &Map<String, Value>) -> bool {
    flag(object, SESSION_KEY)
}

pub(super) fn parse_alarm(object: &Map<String, Value>) -> bool {
    flag(object, ALARM_KEY)
}

pub(super) fn write(map: &mut Map<String, Value>, session: bool, alarm: bool) {
    map.insert(SESSION_KEY.to_string(), json!(session));
    map.insert(ALARM_KEY.to_string(), json!(alarm));
}

impl SettingsStore {
    /// Plain read for the notification path, avoiding a whole-`Settings` clone.
    pub fn session_notification_sounds(&self) -> bool {
        self.data.session_notification_sounds
    }

    /// Plain read for the alarm scheduler, avoiding a whole-`Settings` clone.
    pub fn alarm_sounds(&self) -> bool {
        self.data.alarm_sounds
    }

    pub async fn set_session_notification_sounds(
        &mut self,
        enabled: bool,
    ) -> std::io::Result<Settings> {
        let next = Settings {
            session_notification_sounds: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    pub async fn set_alarm_sounds(&mut self, enabled: bool) -> std::io::Result<Settings> {
        let next = Settings {
            alarm_sounds: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}
