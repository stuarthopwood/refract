use super::*;
use crate::usage::error_category::ErrorCategory;
use crate::usage::rollup::{record_tool_call, record_tool_result, ToolCallRow};
use crate::usage::schema;

const NOW: i64 = 1_790_000_000_000;

fn ctx() -> QueryCtx {
    QueryCtx {
        now_ms: NOW,
        tz_offset_minutes: 0,
    }
}

fn scratch_db() -> Connection {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = crate::test_scratch::path(format!(
        "refract-usage-summary-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    schema::open_db(&dir.join("usage.db")).unwrap()
}

/// One failed, one successful and one running call.
fn error_success_running() -> Connection {
    let conn = scratch_db();
    for id in ["failed", "ok", "pending"] {
        let row = ToolCallRow {
            tool_call_id: id,
            entry_id: "e",
            ts: NOW - 60_000,
            tool: "bash",
            cost_usd: 0.0,
            project_id: "proj",
            model: "m1",
            reasoning: "",
            agent_type: "main",
        };
        assert!(record_tool_call(&conn, "file", &row).unwrap());
    }
    record_tool_result(&conn, "file", "failed", Some(ErrorCategory::Other), 4).unwrap();
    record_tool_result(&conn, "file", "ok", None, 4).unwrap();
    conn
}

fn assert_half_of_two_resolved(s: &Summary) {
    assert_eq!(s.tool_calls, 3);
    assert_eq!(s.tool_resolved, 2);
    assert!((s.tool_error_rate - 0.5).abs() < 1e-9);
}

#[test]
fn the_error_rate_ignores_a_running_call_on_the_rollup_path() {
    let conn = error_success_running();
    let f = Filters {
        range: "7d".into(),
        ..Filters::default()
    };
    assert!(!f.needs_tool_calls());

    assert_half_of_two_resolved(&summary(&conn, &f, &ctx()).unwrap());
}

#[test]
fn the_error_rate_ignores_a_running_call_on_the_per_call_path() {
    let conn = error_success_running();
    let f = Filters {
        range: "7d".into(),
        model: Some("m1".into()),
        ..Filters::default()
    };
    assert!(f.needs_tool_calls());

    assert_half_of_two_resolved(&summary(&conn, &f, &ctx()).unwrap());
}

#[test]
fn a_window_with_only_running_calls_has_a_zero_rate_not_a_division_error() {
    let conn = scratch_db();
    let row = ToolCallRow {
        tool_call_id: "pending",
        entry_id: "e",
        ts: NOW - 60_000,
        tool: "bash",
        cost_usd: 0.0,
        project_id: "proj",
        model: "m1",
        reasoning: "",
        agent_type: "main",
    };
    record_tool_call(&conn, "file", &row).unwrap();
    let f = Filters {
        range: "7d".into(),
        ..Filters::default()
    };

    let s = summary(&conn, &f, &ctx()).unwrap();

    assert_eq!((s.tool_calls, s.tool_resolved), (1, 0));
    assert_eq!(s.tool_error_rate, 0.0);
}
