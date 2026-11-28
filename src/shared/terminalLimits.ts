// Terminal limits (spec 144). Mirrored in Rust `terminal/limits.rs`; a parity test compares the two.

export const MAX_TABS_PER_SESSION = 8
export const SCROLLBACK_BYTES = 2_097_152
export const ASK_FALLBACK_LINES = 200
export const OUTPUT_CAP_BYTES = 32_768
export const NAME_MAX_CHARS = 40
export const INPUT_MAX_BYTES = 65_536
export const INPUT_RATE_BYTES_PER_SEC = 1_048_576
export const COLS_MAX = 500
export const ROWS_MAX = 200
/** The renderer acks after this many written bytes. */
export const ACK_EVERY_BYTES = 131_072
/** The Rust reader pauses while an attached tab has more than this unacked. */
export const UNACKED_PAUSE_BYTES = 524_288
