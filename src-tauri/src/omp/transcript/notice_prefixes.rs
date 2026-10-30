//! `notice`-id prefix constants, split out of transcript.rs for the file-size cap (#938).

/// `id` prefix for the `notice` a hidden tool's failure becomes.
pub(super) const HIDDEN_TOOL_NOTICE_PREFIX: &str = "hidden-tool-error:";

/// `id` prefix for a `notice` from a frame that arrived before any user action in this process.
pub(super) const STARTUP_NOTICE_PREFIX: &str = "startup-notice:";

/// `id` prefix for a real, post-startup `command_output` notice; the renderer's `computeTurnEnd`
/// excludes it from a turn's total time. Shown, unlike `STARTUP_NOTICE_PREFIX` (#938).
pub(super) const COMMAND_OUTPUT_NOTICE_PREFIX: &str = "command-output:";
