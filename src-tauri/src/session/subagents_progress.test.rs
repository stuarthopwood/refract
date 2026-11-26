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

fn entry() -> SummaryEntry {
    SummaryEntry {
        id: "t1:a".into(),
        tool_call_id: "t1".into(),
        spec_index: 0,
        name_or_task: "a".into(),
        name: None,
        task_summary: None,
        status: SummaryStatus::Running,
        started_at: 1,
        duration_ms: None,
        background: false,
        role: None,
        overall_goal: None,
        files_touched: Vec::new(),
        recent_steps: Vec::new(),
    }
}

fn beat(tools: Value) -> Value {
    json!({ "recentTools": tools })
}

#[test]
fn files_touched_collects_write_and_edit_paths_once_in_first_seen_order() {
    let mut e = entry();
    let changed = accumulate_heartbeat(
        &mut e,
        &beat(json!([
            { "tool": "write", "args": "src/b.rs", "endMs": 1 },
            { "tool": "read", "args": "src/skip.rs", "endMs": 2 },
            { "tool": "edit", "args": { "path": "src/a.rs" }, "endMs": 3 },
            { "tool": "edit", "args": "src/b.rs", "endMs": 4 }
        ])),
    );
    assert!(changed);
    assert_eq!(e.files_touched, vec!["src/b.rs", "src/a.rs"]);
}

#[test]
fn files_touched_dedupes_across_heartbeats() {
    let mut e = entry();
    let tools = beat(json!([{ "tool": "write", "args": "x.rs", "endMs": 1 }]));
    accumulate_heartbeat(&mut e, &tools);
    assert!(!accumulate_heartbeat(&mut e, &tools));
    assert_eq!(e.files_touched, vec!["x.rs"]);
}

#[test]
fn files_touched_stops_at_fifty() {
    let mut e = entry();
    let tools: Vec<Value> = (0..60)
        .map(|n| json!({ "tool": "write", "args": format!("f{n}.rs"), "endMs": n }))
        .collect();
    accumulate_heartbeat(&mut e, &beat(Value::Array(tools)));
    assert_eq!(e.files_touched.len(), 50);
    assert_eq!(e.files_touched[0], "f0.rs");
    assert_eq!(e.files_touched[49], "f49.rs");
}

#[test]
fn recent_steps_keep_the_newest_five_in_order_with_their_fields() {
    let mut e = entry();
    let tools: Vec<Value> = (0..8)
        .map(|n| json!({ "tool": "bash", "args": format!("c{n}"), "intent": "Run", "isError": n == 7, "endMs": n }))
        .collect();
    accumulate_heartbeat(&mut e, &beat(Value::Array(tools)));
    assert_eq!(e.recent_steps.len(), 5);
    assert_eq!(e.recent_steps[0].end_ms, Some(3));
    assert_eq!(e.recent_steps[4].target.as_deref(), Some("c7"));
    assert_eq!(e.recent_steps[4].is_error, Some(true));
    assert_eq!(e.recent_steps[4].intent.as_deref(), Some("Run"));
}

#[test]
fn a_frame_without_recent_tools_changes_nothing() {
    let mut e = entry();
    assert!(!accumulate_heartbeat(
        &mut e,
        &json!({ "status": "running" })
    ));
    assert!(e.files_touched.is_empty() && e.recent_steps.is_empty());
}

#[test]
fn serialisation_omits_absent_synthesis_and_progress_fields() {
    let value = summaries_to_value(&[entry()]);
    let obj = value[0].as_object().expect("object");
    for key in ["role", "overallGoal", "filesTouched", "recentSteps"] {
        assert!(!obj.contains_key(key), "{key} must be omitted");
    }
}

#[test]
fn serialisation_emits_present_fields_in_camel_case_without_nulls() {
    let mut e = entry();
    e.role = Some("Reviewer".into());
    e.overall_goal = Some("Ship it".into());
    accumulate_heartbeat(
        &mut e,
        &beat(json!([{ "tool": "write", "args": "a.rs", "endMs": 9 }])),
    );
    let value = summaries_to_value(&[e]);
    assert_eq!(value[0]["role"], "Reviewer");
    assert_eq!(value[0]["overallGoal"], "Ship it");
    assert_eq!(value[0]["filesTouched"], json!(["a.rs"]));
    assert_eq!(
        value[0]["recentSteps"],
        json!([{ "tool": "write", "target": "a.rs", "endMs": 9 }])
    );
}
