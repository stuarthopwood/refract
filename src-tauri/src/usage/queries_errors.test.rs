use super::*;
use crate::usage::error_category::ErrorCategory;
use crate::usage::rollup::{record_tool_call, record_tool_result, ToolCallRow};
use crate::usage::schema;
use crate::usage::timeutil::DAY_MS;

const NOW: i64 = 1_790_000_000_000;

fn ctx() -> QueryCtx {
    QueryCtx {
        now_ms: NOW,
        tz_offset_minutes: 0,
    }
}

fn filters(range: &str) -> Filters {
    Filters {
        range: range.into(),
        ..Filters::default()
    }
}

fn scratch_db() -> Connection {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = crate::test_scratch::path(format!(
        "refract-usage-errors-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    schema::open_db(&dir.join("usage.db")).unwrap()
}

/// One call with its result: `Some(category)` failed, `None` succeeded.
fn finished(
    conn: &Connection,
    id: &str,
    project: &str,
    ago_ms: i64,
    outcome: Option<ErrorCategory>,
) {
    running(conn, id, project, ago_ms);
    assert!(record_tool_result(conn, "file", id, outcome, 10).unwrap());
}

/// A call whose result has not arrived.
fn running(conn: &Connection, id: &str, project: &str, ago_ms: i64) {
    let row = ToolCallRow {
        tool_call_id: id,
        entry_id: "e",
        ts: NOW - ago_ms,
        tool: "bash",
        cost_usd: 0.0,
        project_id: project,
        model: "m1",
        reasoning: "",
        agent_type: "main",
    };
    assert!(record_tool_call(conn, "file", &row).unwrap());
}

fn pairs(rows: Vec<ErrorCategoryRow>) -> Vec<(String, i64)> {
    rows.into_iter().map(|r| (r.category, r.count)).collect()
}

fn mixed() -> Connection {
    let conn = scratch_db();
    for (i, category) in [
        ErrorCategory::Policy,
        ErrorCategory::Policy,
        ErrorCategory::Policy,
        ErrorCategory::Timeout,
        ErrorCategory::Timeout,
        ErrorCategory::Aborted,
    ]
    .into_iter()
    .enumerate()
    {
        finished(&conn, &format!("e{i}"), "proj", 60_000, Some(category));
    }
    // An error recorded before categories existed has no stored category.
    finished(&conn, "legacy", "proj", 60_000, Some(ErrorCategory::Other));
    conn.execute(
        "UPDATE tool_calls SET error_category = NULL WHERE tool_call_id = 'legacy'",
        [],
    )
    .unwrap();
    finished(&conn, "ok", "proj", 60_000, None);
    running(&conn, "pending", "proj", 60_000);
    conn
}

#[test]
fn failed_calls_are_counted_by_category_most_frequent_first() {
    let conn = mixed();

    let rows = pairs(error_categories(&conn, &filters("7d"), &ctx()).unwrap());

    assert_eq!(
        rows,
        vec![
            ("policy".to_string(), 3),
            ("timeout".to_string(), 2),
            ("aborted".to_string(), 1),
            ("unknown".to_string(), 1),
        ]
    );
}

#[test]
fn a_legacy_error_with_no_stored_category_is_reported_as_unknown() {
    let conn = scratch_db();
    finished(&conn, "legacy", "proj", 60_000, Some(ErrorCategory::Other));
    conn.execute("UPDATE tool_calls SET error_category = NULL", [])
        .unwrap();

    let rows = pairs(error_categories(&conn, &filters("7d"), &ctx()).unwrap());

    assert_eq!(rows, vec![("unknown".to_string(), 1)]);
}

#[test]
fn successes_and_running_calls_are_not_failures() {
    let conn = scratch_db();
    finished(&conn, "ok", "proj", 60_000, None);
    running(&conn, "pending", "proj", 60_000);

    assert!(error_categories(&conn, &filters("7d"), &ctx())
        .unwrap()
        .is_empty());
}

#[test]
fn a_project_filter_narrows_the_categories() {
    let conn = scratch_db();
    finished(&conn, "a1", "proj-a", 60_000, Some(ErrorCategory::Policy));
    finished(&conn, "a2", "proj-a", 60_000, Some(ErrorCategory::Policy));
    finished(&conn, "b1", "proj-b", 60_000, Some(ErrorCategory::Timeout));

    let only_a = Filters {
        project: Some("proj-a".into()),
        ..filters("7d")
    };
    let none = Filters {
        project: Some("elsewhere".into()),
        ..filters("7d")
    };

    assert_eq!(
        pairs(error_categories(&conn, &only_a, &ctx()).unwrap()),
        vec![("policy".to_string(), 2)]
    );
    assert_eq!(
        pairs(error_categories(&conn, &filters("7d"), &ctx()).unwrap()).len(),
        2
    );
    assert!(error_categories(&conn, &none, &ctx()).unwrap().is_empty());
}

#[test]
fn a_date_range_drops_failures_outside_it() {
    let conn = scratch_db();
    finished(&conn, "new", "proj", 60_000, Some(ErrorCategory::Policy));
    finished(
        &conn,
        "old",
        "proj",
        10 * DAY_MS,
        Some(ErrorCategory::Timeout),
    );

    let week = pairs(error_categories(&conn, &filters("7d"), &ctx()).unwrap());
    let all = pairs(error_categories(&conn, &filters("all"), &ctx()).unwrap());

    assert_eq!(week, vec![("policy".to_string(), 1)]);
    assert_eq!(all.len(), 2);
}

#[test]
fn an_unknown_range_is_rejected() {
    let conn = scratch_db();

    assert!(error_categories(&conn, &filters("forever"), &ctx()).is_err());
}
