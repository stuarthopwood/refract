use super::*;

// The same literals are asserted by `src/shared/terminalLimits.test.ts`; a drift on either side fails one of the two.
#[test]
fn constants_match_the_frozen_data_model() {
    assert_eq!(MAX_TABS_PER_SESSION, 8);
    assert_eq!(SCROLLBACK_BYTES, 2_097_152);
    assert_eq!(ASK_FALLBACK_LINES, 200);
    assert_eq!(OUTPUT_CAP_BYTES, 32_768);
    assert_eq!(NAME_MAX_CHARS, 40);
    assert_eq!(INPUT_MAX_BYTES, 65_536);
    assert_eq!(INPUT_RATE_BYTES_PER_SEC, 1_048_576);
    assert_eq!((COLS_MIN, COLS_MAX), (1, 500));
    assert_eq!((ROWS_MIN, ROWS_MAX), (1, 200));
    assert_eq!(ACK_EVERY_BYTES, 131_072);
    assert_eq!(UNACKED_PAUSE_BYTES, 524_288);
}
