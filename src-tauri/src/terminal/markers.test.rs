// The OSC 133 scanner, ANSI stripping, recent-command extraction and the output cap, all on byte slices.

use super::*;

const A_BEL: &[u8] = b"\x1b]133;A\x07";
const A_ST: &[u8] = b"\x1b]133;A\x1b\\";

fn scanned(chunks: &[&[u8]]) -> Vec<u64> {
    let mut scanner = MarkerScanner::new();
    let mut base = 0u64;
    for chunk in chunks {
        scanner.feed(chunk, base);
        base += chunk.len() as u64;
    }
    scanner.offsets()
}

#[test]
fn a_bel_terminated_marker_is_recorded_just_past_its_end() {
    assert_eq!(scanned(&[b"ab\x1b]133;A\x07PS> "]), vec![10]);
}

#[test]
fn a_string_terminator_ends_a_marker_too() {
    assert_eq!(scanned(&[b"\x1b]133;A\x1b\\PS> "]), vec![9]);
}

#[test]
fn a_marker_split_at_every_byte_is_still_found() {
    for terminator_form in [A_BEL, A_ST] {
        let mut text = b"out\r\n".to_vec();
        text.extend_from_slice(terminator_form);
        let chunks: Vec<&[u8]> = text.chunks(1).collect();

        assert_eq!(scanned(&chunks), vec![text.len() as u64]);
    }
}

#[test]
fn offsets_use_the_stream_position_of_each_read() {
    let offsets = scanned(&[b"1234", A_BEL, b"cmd\r\n", A_BEL]);

    assert_eq!(offsets, vec![4 + 8, 4 + 8 + 5 + 8]);
}

#[test]
fn other_sequences_and_broken_markers_are_not_recorded() {
    let noise: &[&[u8]] = &[
        b"\x1b]133;B\x07",
        b"\x1b]133;A",
        b"\x1b]133;Ax",
        b"\x1b]0;title\x07",
        b"\x1b[133;A\x07",
        b"\x1b]13A\x07",
        b"\x1b]133;A\x1bx",
    ];
    for sample in noise {
        assert!(scanned(&[sample]).is_empty(), "{sample:?}");
    }
}

#[test]
fn a_marker_straight_after_a_broken_one_is_still_found() {
    assert_eq!(scanned(&[b"\x1b]133\x1b]133;A\x07"]), vec![13]);
    assert_eq!(scanned(&[b"\x1b]133;A\x1b\x1b]133;A\x07"]), vec![16]);
}

#[test]
fn only_the_last_sixty_four_offsets_are_kept() {
    let chunks: Vec<&[u8]> = (0..70).map(|_| A_BEL).collect();

    let offsets = scanned(&chunks);

    assert_eq!(offsets.len(), MAX_MARKERS);
    assert_eq!(*offsets.last().unwrap(), 70 * 8);
    assert_eq!(offsets[0], 7 * 8);
}

#[test]
fn offsets_before_the_ring_start_are_dropped() {
    let mut scanner = MarkerScanner::new();
    scanner.feed(&[A_BEL, A_BEL, A_BEL].concat(), 0);

    scanner.drop_before(9);

    assert_eq!(scanner.offsets(), vec![16, 24]);
    scanner.drop_before(16);
    assert_eq!(scanner.offsets(), vec![16, 24]);
}

#[test]
fn ansi_sequences_and_control_characters_are_stripped() {
    let raw = b"\x1b[0m\x1b[1;32mgreen\x1b[0m\x1b]133;A\x07 \x1b]0;title\x1b\\x\x1b(Bok\r\n\x08\tend\x1b[";

    assert_eq!(strip_ansi(raw), "green xok\n\tend");
}

#[test]
fn stripping_keeps_text_that_is_not_ascii() {
    assert_eq!(
        strip_ansi("caf\u{e9} \u{2713}\r\n".as_bytes()),
        "caf\u{e9} \u{2713}\n"
    );
}

// Two commands, each introduced by a prompt marker, then a fresh prompt waiting for input.
const TWO_COMMANDS: &[u8] =
    b"\x1b]133;A\x07PS> echo one\r\none\r\n\x1b]133;A\x07PS> echo two\r\ntwo\r\n\x1b]133;A\x07PS> ";

fn markers_of(bytes: &[u8]) -> Vec<u64> {
    let mut scanner = MarkerScanner::new();
    scanner.feed(bytes, 0);
    scanner.offsets()
}

#[test]
fn a_finished_command_is_the_text_between_its_prompt_and_the_next() {
    let bytes = TWO_COMMANDS;
    let markers = markers_of(bytes);

    let out = extract_recent_command(bytes, 0, &markers).unwrap();

    assert_eq!(strip_ansi(&out).trim(), "PS> echo two\ntwo");
}

#[test]
fn a_command_still_printing_is_everything_after_the_latest_prompt() {
    let bytes = b"\x1b]133;A\x07PS> echo one\r\none\r\n\x1b]133;A\x07PS> slow\r\nfirst line";
    let markers = markers_of(bytes);

    let out = extract_recent_command(bytes, 0, &markers).unwrap();

    assert_eq!(strip_ansi(&out), "PS> slow\nfirst line");
}

#[test]
fn a_prompt_alone_has_no_recent_command() {
    let bytes = b"\x1b]133;A\x07PS> ";

    assert_eq!(extract_recent_command(bytes, 0, &markers_of(bytes)), None);
}

#[test]
fn no_markers_means_no_recent_command() {
    assert_eq!(extract_recent_command(b"plain output\r\n", 0, &[]), None);
}

#[test]
fn offsets_are_read_relative_to_the_ring_start() {
    let bytes = b"\x1b]133;A\x07PS> echo one\r\none\r\n\x1b]133;A\x07PS> ";
    let markers = markers_of(bytes);
    // The ring forgot its first 100 bytes: every offset moves up, the slice does not.
    let shifted: Vec<u64> = markers.iter().map(|m| m + 100).collect();

    let out = extract_recent_command(bytes, 100, &shifted).unwrap();

    assert_eq!(strip_ansi(&out).trim(), "PS> echo one\none");
}

#[test]
fn text_within_the_cap_is_returned_whole() {
    assert_eq!(cap_keeping_end("abc".into(), 3), ("abc".into(), false, 3));
}

#[test]
fn text_over_the_cap_keeps_its_end_and_reports_its_full_size() {
    assert_eq!(
        cap_keeping_end("abcdef".into(), 4),
        ("cdef".into(), true, 6)
    );
}

#[test]
fn the_cap_never_splits_a_character() {
    // Two bytes per character; a cap of 3 would cut the second character in half.
    let (text, truncated, total) = cap_keeping_end("\u{e9}\u{e9}\u{e9}".into(), 3);

    assert_eq!((text.as_str(), truncated, total), ("\u{e9}", true, 6));
}

#[test]
fn output_modes_parse_their_wire_values_and_nothing_else() {
    assert_eq!(
        OutputMode::parse("recent-command"),
        Some(OutputMode::RecentCommand)
    );
    assert_eq!(OutputMode::parse("last-lines"), Some(OutputMode::LastLines));
    assert_eq!(OutputMode::parse("everything"), None);
}

#[test]
fn a_marked_command_is_reported_as_marker_text_without_reading_the_tail() {
    let out = compose_output(
        Some(b"\x1b[32mok\x1b[0m\r\n".to_vec()),
        || panic!("the tail is only for output without markers"),
        100,
    );

    assert_eq!(out.text, "ok\n");
    assert_eq!(out.source, OutputSource::Marker);
    assert!(!out.truncated);
    assert_eq!(out.total_bytes, 3);
}

#[test]
fn without_a_marked_command_the_tail_is_used_and_says_so() {
    let out = compose_output(None, || b"line\r\n".to_vec(), 100);

    assert_eq!(
        (out.text.as_str(), out.source),
        ("line\n", OutputSource::Tail)
    );
}

#[test]
fn long_output_is_cut_to_its_end_with_the_full_size_reported() {
    let out = compose_output(None, || b"abcdefgh".to_vec(), 3);

    assert_eq!(out.text, "fgh");
    assert!(out.truncated);
    assert_eq!(out.total_bytes, 8);
}

#[test]
fn the_wire_shape_is_camel_case_with_a_lowercase_source() {
    let out = compose_output(None, || b"x".to_vec(), 10);

    assert_eq!(
        serde_json::to_value(out).unwrap(),
        serde_json::json!({ "text": "x", "truncated": false, "totalBytes": 1, "source": "tail" })
    );
}
