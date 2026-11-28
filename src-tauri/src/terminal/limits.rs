// Terminal constants, frozen in `specs/144-right-panel-terminal-3/data-model.md` and mirrored in
// `src/shared/terminalLimits.ts`. Change both files together.

/// FR-009.
pub const MAX_TABS_PER_SESSION: usize = 8;
/// FR-010: bytes kept per tab, in memory only.
pub const SCROLLBACK_BYTES: usize = 2_097_152;
/// FR-020: lines `terminal.readOutput` falls back to without prompt markers.
pub const ASK_FALLBACK_LINES: usize = 200;
/// FR-021: the most `terminal.readOutput` returns, keeping the end.
pub const OUTPUT_CAP_BYTES: usize = 32_768;
/// Tab name length, in characters.
pub const NAME_MAX_CHARS: usize = 40;
/// FR-024: per `terminal.input` call.
pub const INPUT_MAX_BYTES: usize = 65_536;
/// FR-024: per tab.
pub const INPUT_RATE_BYTES_PER_SEC: usize = 1_048_576;
pub const COLS_MIN: u16 = 1;
pub const COLS_MAX: u16 = 500;
pub const ROWS_MIN: u16 = 1;
pub const ROWS_MAX: u16 = 200;
/// The renderer acks after this many bytes written to xterm.
pub const ACK_EVERY_BYTES: usize = 131_072;
/// The reader pauses while a tab has this many bytes sent but unacked.
pub const UNACKED_PAUSE_BYTES: usize = 524_288;

#[cfg(test)]
#[path = "limits.test.rs"]
mod tests;
