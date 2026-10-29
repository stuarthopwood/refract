// Issue #1048 (Settings, Appearance "Holiday touches"): same reason `chat_width.rs` was split
// into its own file (not inline in `settings.rs`) -- keeps that file under this build's 600-line
// cap (issue #806).
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HolidayTouches {
    Full,
    Artwork,
    Off,
}

pub(super) const KEY: &str = "holidayTouches";

/// Default `Full` -- a missing/malformed value is never trusted, the same lazy-correction
/// pattern `chat_width` uses.
pub(super) fn parse(object: &Map<String, Value>) -> HolidayTouches {
    object
        .get(KEY)
        .and_then(|v| serde_json::from_value::<HolidayTouches>(v.clone()).ok())
        .unwrap_or(HolidayTouches::Full)
}

pub(super) fn write(map: &mut Map<String, Value>, value: HolidayTouches) {
    map.insert(KEY.to_string(), json!(value));
}
