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

fn ts_constants() -> Vec<(String, u64)> {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/shared/terminalLimits.ts");
    let source =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    source
        .lines()
        .filter_map(|line| {
            let (name, value) = line.strip_prefix("export const ")?.split_once(" = ")?;
            let digits: String = value.trim().chars().filter(|c| *c != '_').collect();
            Some((
                name.to_string(),
                digits
                    .parse()
                    .unwrap_or_else(|e| panic!("{name} = {value}: {e}")),
            ))
        })
        .collect()
}

// Rust is the enforcing side; the renderer mirror must never drift from it.
#[test]
fn renderer_limits_match_the_rust_twins() {
    let rust: [(&str, u64); 11] = [
        ("MAX_TABS_PER_SESSION", MAX_TABS_PER_SESSION as u64),
        ("SCROLLBACK_BYTES", SCROLLBACK_BYTES as u64),
        ("ASK_FALLBACK_LINES", ASK_FALLBACK_LINES as u64),
        ("OUTPUT_CAP_BYTES", OUTPUT_CAP_BYTES as u64),
        ("NAME_MAX_CHARS", NAME_MAX_CHARS as u64),
        ("INPUT_MAX_BYTES", INPUT_MAX_BYTES as u64),
        ("INPUT_RATE_BYTES_PER_SEC", INPUT_RATE_BYTES_PER_SEC as u64),
        ("COLS_MAX", COLS_MAX as u64),
        ("ROWS_MAX", ROWS_MAX as u64),
        ("ACK_EVERY_BYTES", ACK_EVERY_BYTES as u64),
        ("UNACKED_PAUSE_BYTES", UNACKED_PAUSE_BYTES as u64),
    ];
    let ts = ts_constants();
    assert_eq!(ts.len(), rust.len(), "terminalLimits.ts exports {ts:?}");
    for (name, value) in rust {
        let twin = ts
            .iter()
            .find(|(n, _)| n == name)
            .unwrap_or_else(|| panic!("{name} missing from terminalLimits.ts"));
        assert_eq!(
            twin.1, value,
            "{name} differs between limits.rs and terminalLimits.ts"
        );
    }
}
