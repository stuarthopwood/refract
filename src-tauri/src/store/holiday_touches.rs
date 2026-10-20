// Issue #1048 (Settings, Appearance "Holiday touches"): same reason `chat_width.rs` was split
// into its own file (not inline in `settings.rs`) -- keeps that file under this build's 600-line
// cap (issue #806).
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HolidayTouches {
    Full,
    Artwork,
    Off,
}
