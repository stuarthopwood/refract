//! Issue #938 item 4: the `notice`-id prefix constants were previously declared inline in
//! transcript.rs; grouping all three together here keeps that file under the 600-line
//! file-size cap (scripts/check-file-size.mjs).

/// `id` prefix for the `notice` a hidden tool's failure becomes (T086, FR-052;
/// `HIDDEN_TOOL_NOTICE_PREFIX`).
pub(super) const HIDDEN_TOOL_NOTICE_PREFIX: &str = "hidden-tool-error:";

/// `id` prefix for a `notice` built from a `command_output`/`notice` frame that arrived before
/// the user had taken any action in this agent process (`STARTUP_NOTICE_PREFIX`).
pub(super) const STARTUP_NOTICE_PREFIX: &str = "startup-notice:";

/// `id` prefix for a `notice` built specifically from a real, post-startup `command_output`
/// frame (issue #938 item 4, `COMMAND_OUTPUT_NOTICE_PREFIX` in `src/shared/model.ts`): the
/// renderer's `computeTurnEnd` excludes any notice carrying this prefix from a turn's own total
/// time, since a command reply is not part of any turn's own timing. Distinct from
/// `STARTUP_NOTICE_PREFIX` above (that one is suppressed from view; this one is a real, shown
/// reply that is only excluded from the time sum). Only the `command_output` frame type uses
/// this prefix; a plain `notice` frame keeps the ordinary `notice-N` id.
pub(super) const COMMAND_OUTPUT_NOTICE_PREFIX: &str = "command-output:";
