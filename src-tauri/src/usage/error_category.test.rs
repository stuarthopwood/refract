use super::*;

#[test]
fn a_tool_policy_refusal_is_policy() {
    let text = "Tool \"bash\" is blocked by tool policy. Reason: Use the `read` tool instead of cat";
    assert_eq!(classify(text), ErrorCategory::Policy);
}

#[test]
fn a_rejected_edit_is_edit_rejected_even_when_it_names_a_missing_path() {
    assert_eq!(
        classify("Edit rejected for specs/x.md: hash mismatch, file not found in snapshot"),
        ErrorCategory::EditRejected
    );
    assert_eq!(
        classify("This edit anchors to lines 4-9 of a stale file"),
        ErrorCategory::EditRejected
    );
    assert_eq!(
        classify("line has no preceding hunk header"),
        ErrorCategory::EditRejected
    );
}

#[test]
fn timeouts_and_aborts_are_separate_categories() {
    assert_eq!(classify("eval cell timed out after 30s"), ErrorCategory::Timeout);
    assert_eq!(classify("Operation aborted"), ErrorCategory::Aborted);
    assert_eq!(classify("request was cancelled"), ErrorCategory::Aborted);
}

#[test]
fn a_missing_path_is_not_found() {
    assert_eq!(
        classify("Path 'src/a.ts' not found"),
        ErrorCategory::NotFound
    );
    assert_eq!(
        classify("Working directory does not exist: C:/x"),
        ErrorCategory::NotFound
    );
}

#[test]
fn failed_validation_is_invalid_input() {
    assert_eq!(
        classify("Validation failed for \"mcp_x\": - query: required"),
        ErrorCategory::InvalidInput
    );
}

#[test]
fn matching_ignores_case() {
    assert_eq!(classify("BLOCKED BY TOOL POLICY"), ErrorCategory::Policy);
}

#[test]
fn text_that_matches_nothing_is_other_and_never_unknown() {
    assert_eq!(classify("fatal: unexpected"), ErrorCategory::Other);
    assert_eq!(classify(""), ErrorCategory::Other);
}

#[test]
fn a_cause_past_the_scan_window_is_ignored() {
    let text = format!("{}timed out", "x".repeat(MAX_SCAN_CHARS));
    assert_eq!(classify(&text), ErrorCategory::Other);
}

#[test]
fn every_category_has_a_distinct_stored_name_and_a_display_slot() {
    let mut names: Vec<_> = ErrorCategory::ALL.iter().map(|c| c.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), ErrorCategory::ALL.len());
}
