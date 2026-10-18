// Issue #554 (amends FR-049, new FR-073): Settings, Appearance "Chat width" choice. Split into
// its own file (not inline in `settings.rs`) to keep that file under this build's 600-line cap
// (issue #806), the same reason `settings_tests.rs` was split out.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChatWidth {
    Full,
    ReadingColumn,
}
