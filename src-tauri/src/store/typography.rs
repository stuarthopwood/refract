// Settings > Appearance "Text size": three persisted scale multipliers; child module of
// `settings.rs` for the size cap (#806).
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::{Settings, SettingsStore};

pub(super) const KEY: &str = "typography";
pub const MIN_SCALE: f64 = 0.8;
pub const MAX_SCALE: f64 = 1.5;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Typography {
    pub app_scale: f64,
    pub chat_scale: f64,
    pub code_scale: f64,
}

impl Default for Typography {
    fn default() -> Self {
        Self {
            app_scale: 1.0,
            chat_scale: 1.0,
            code_scale: 1.0,
        }
    }
}

/// A non-finite value reads as the default; anything else is clamped into range.
pub fn clamp_scale(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(MIN_SCALE, MAX_SCALE)
    } else {
        1.0
    }
}

fn parse_scale(object: &Map<String, Value>, key: &str) -> f64 {
    object
        .get(key)
        .and_then(Value::as_f64)
        .map_or(1.0, clamp_scale)
}

/// Absent or malformed reads as the defaults, per field.
pub(super) fn parse(object: &Map<String, Value>) -> Typography {
    match object.get(KEY).and_then(Value::as_object) {
        Some(inner) => Typography {
            app_scale: parse_scale(inner, "appScale"),
            chat_scale: parse_scale(inner, "chatScale"),
            code_scale: parse_scale(inner, "codeScale"),
        },
        None => Typography::default(),
    }
}

pub(super) fn write(map: &mut Map<String, Value>, typography: Typography) {
    map.insert(KEY.to_string(), json!(typography));
}

impl SettingsStore {
    /// Clamps values into range.
    pub async fn set_typography(&mut self, typography: Typography) -> std::io::Result<Settings> {
        let next = Settings {
            typography: Typography {
                app_scale: clamp_scale(typography.app_scale),
                chat_scale: clamp_scale(typography.chat_scale),
                code_scale: clamp_scale(typography.code_scale),
            },
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}
