use serde_json::json;

use super::*;

fn rows(progress: &Value) -> Vec<Value> {
    let mut state = State::default();
    apply_subagent_progress_in_place(&mut state, "sub-1", progress)
}

#[test]
fn a_tool_entry_intent_is_its_own_row_field_and_not_the_target() {
    let rows = rows(&json!({
        "recentTools": [{ "tool": "read", "args": "src/a.rs", "intent": "Reading the file: for context", "endMs": 5 }]
    }));
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["intent"], "Reading the file: for context");
    assert_eq!(rows[0]["target"], "src/a.rs");
}

#[test]
fn a_tool_entry_without_args_targets_the_tool_name_and_keeps_its_intent() {
    let rows = rows(&json!({
        "recentTools": [{ "tool": "bash", "intent": "Run the build", "endMs": 6 }]
    }));
    assert_eq!(rows[0]["target"], "bash");
    assert_eq!(rows[0]["intent"], "Run the build");
}

#[test]
fn a_tool_entry_without_an_intent_has_no_intent_field() {
    let rows = rows(&json!({
        "recentTools": [{ "tool": "bash", "args": "ls", "endMs": 7 }]
    }));
    assert!(rows[0].get("intent").is_none());
    assert_eq!(rows[0]["target"], "ls");
}
