use super::*;

fn one(text: &str) -> ErrorCategory {
    classify([text])
}

#[test]
fn every_needle_lands_in_its_category() {
    let rows: [(&str, ErrorCategory); 17] = [
        (
            "Tool \"bash\" is blocked by tool policy. Reason: use read",
            ErrorCategory::Policy,
        ),
        ("Edit rejected for specs/x.md", ErrorCategory::EditRejected),
        (
            "This edit anchors to lines 4-9 of a stale file",
            ErrorCategory::EditRejected,
        ),
        (
            "line has no preceding hunk header",
            ErrorCategory::EditRejected,
        ),
        ("eval cell timed out after 30s", ErrorCategory::Timeout),
        ("socket timeout", ErrorCategory::Timeout),
        ("Operation aborted", ErrorCategory::Aborted),
        ("request was cancelled", ErrorCategory::Aborted),
        ("request was canceled", ErrorCategory::Aborted),
        ("Path 'src/a.ts' not found", ErrorCategory::NotFound),
        ("no such file or directory", ErrorCategory::NotFound),
        (
            "Working directory does not exist: C:/x",
            ErrorCategory::NotFound,
        ),
        ("spawn ENOENT", ErrorCategory::NotFound),
        (
            "Validation failed for \"mcp_x\": - query: required",
            ErrorCategory::InvalidInput,
        ),
        ("invalid argument", ErrorCategory::InvalidInput),
        ("missing required field", ErrorCategory::InvalidInput),
        ("fatal: unexpected", ErrorCategory::Other),
    ];
    for (text, want) in rows {
        assert_eq!(one(text), want, "text: {text}");
    }
}

#[test]
fn the_earlier_rule_wins_when_a_message_fits_two() {
    let rows: [(&str, ErrorCategory); 4] = [
        ("invalid timeout value", ErrorCategory::Timeout),
        (
            "Edit rejected for specs/x.md: hash mismatch, file not found in snapshot",
            ErrorCategory::EditRejected,
        ),
        (
            "blocked by tool policy: request timed out",
            ErrorCategory::Policy,
        ),
        ("invalid path: file does not exist", ErrorCategory::NotFound),
    ];
    for (text, want) in rows {
        assert_eq!(one(text), want, "text: {text}");
    }
}

#[test]
fn matching_ignores_case() {
    assert_eq!(one("BLOCKED BY TOOL POLICY"), ErrorCategory::Policy);
}

#[test]
fn a_cause_that_ends_at_the_scan_window_counts_and_one_past_it_does_not() {
    let needle = "timeout";
    let at_edge = format!("{}{needle}", "x".repeat(MAX_SCAN_CHARS - needle.len()));
    let one_past = format!("{}{needle}", "x".repeat(MAX_SCAN_CHARS - needle.len() + 1));

    assert_eq!(one(&at_edge), ErrorCategory::Timeout);
    assert_eq!(one(&one_past), ErrorCategory::Other);
}

#[test]
fn the_scan_window_counts_chars_not_bytes() {
    let needle = "timeout";
    let prefix = "\u{1F525}".repeat(MAX_SCAN_CHARS - needle.len());

    assert_eq!(one(&format!("{prefix}{needle}")), ErrorCategory::Timeout);
    assert_eq!(one("\u{1F525} timed out"), ErrorCategory::Timeout);
}

#[test]
fn the_window_runs_across_parts_and_a_later_part_past_it_is_ignored() {
    assert_eq!(
        classify(["all good", "then timed out"]),
        ErrorCategory::Timeout
    );
    let long = "x".repeat(MAX_SCAN_CHARS);
    assert_eq!(classify([long.as_str(), "timed out"]), ErrorCategory::Other);
}

#[test]
fn empty_input_is_other_and_never_unknown() {
    assert_eq!(one(""), ErrorCategory::Other);
    assert_eq!(classify([]), ErrorCategory::Other);
    assert_eq!(classify(["", ""]), ErrorCategory::Other);
}

#[test]
fn every_category_has_a_distinct_stored_name_and_a_display_slot() {
    let mut names: Vec<_> = ErrorCategory::ALL.iter().map(|c| c.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), ErrorCategory::ALL.len());
}
