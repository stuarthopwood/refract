use serde_json::json;

use super::*;
use crate::session::subagents::SummaryStatus;

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
fn long_paths_intents_tools_and_targets_are_cut_to_300_chars_on_a_char_boundary() {
    let long = "é".repeat(500);
    let mut e = entry();
    accumulate_heartbeat(
        &mut e,
        &beat(json!([
            { "tool": "write", "args": long, "intent": long, "endMs": 1 },
            { "tool": long, "endMs": 2 }
        ])),
    );
    assert_eq!(e.files_touched[0].chars().count(), 300);
    assert_eq!(
        e.recent_steps[0].intent.as_deref().unwrap().chars().count(),
        300
    );
    assert_eq!(
        e.recent_steps[0].target.as_deref().unwrap().chars().count(),
        300
    );
    assert_eq!(e.recent_steps[1].tool.chars().count(), 300);
}

#[test]
fn a_string_under_the_cap_is_kept_whole() {
    let mut e = entry();
    let exact = "p".repeat(300);
    accumulate_heartbeat(
        &mut e,
        &beat(json!([{ "tool": "edit", "args": exact, "endMs": 1 }])),
    );
    assert_eq!(e.files_touched[0], exact);
}
