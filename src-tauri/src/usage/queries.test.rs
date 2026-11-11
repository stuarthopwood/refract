// Filter SQL must stay parameterised; hostile values are bound, never spliced.

use super::*;
use crate::usage::queries_summary::summary;
use crate::usage::queries_tables::{breakdown, calls, BreakdownBy, Page, Sort};
use crate::usage::rollup::{record_message, record_tool_call, MessageRow, ToolCallRow};
use crate::usage::schema;

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
    let dir = crate::test_scratch::path(format!("refract-usage-q-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    schema::open_db(&dir.join("usage.db")).unwrap()
}

#[test]
fn a_hostile_filter_value_is_bound_never_spliced() {
    let hostile = "x'; DROP TABLE messages; --";
    let f = Filters {
        project: Some(hostile.into()),
        model: Some(hostile.into()),
        ..filters("30d")
    };
    let w = f.build(&MESSAGES, &ctx()).unwrap();
    let sql = w.sql();
    assert!(!sql.contains("DROP") && !sql.contains('\''));
    assert_eq!(w.params().count(), 3);
    assert!(sql.contains("?1") && sql.contains("?2") && sql.contains("?3"));

    let conn = scratch_db();
    let s = summary(&conn, &f, &ctx()).unwrap();
    assert_eq!(s.calls, 0);
    let count: i64 = conn
        .query_row("SELECT count(*) FROM messages", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn unknown_range_agent_sort_key_direction_and_page_size_are_rejected() {
    let conn = scratch_db();
    assert!(matches!(
        summary(&conn, &filters("forever"), &ctx()),
        Err(QueryError::InvalidArgument(_))
    ));
    let bad_agent = Filters {
        agent_type: Some("other".into()),
        ..filters("all")
    };
    assert!(summary(&conn, &bad_agent, &ctx()).is_err());

    let ok_page = Page { index: 0, size: 10 };
    let sort = |key: &str, dir: &str| Sort {
        key: key.into(),
        dir: dir.into(),
    };
    let f = filters("all");
    assert!(calls(
        &conn,
        &f,
        &sort("ts; DROP TABLE messages", "asc"),
        ok_page,
        &ctx()
    )
    .is_err());
    assert!(calls(&conn, &f, &sort("ts", "sideways"), ok_page, &ctx()).is_err());
    assert!(calls(
        &conn,
        &f,
        &sort("ts", "desc"),
        Page {
            index: 0,
            size: 101
        },
        &ctx()
    )
    .is_err());
    assert!(calls(&conn, &f, &sort("usd", "desc"), ok_page, &ctx()).is_ok());
}

#[test]
fn today_starts_at_local_midnight_and_rollup_filters_on_the_hour() {
    let east = QueryCtx {
        now_ms: NOW,
        tz_offset_minutes: 120,
    };
    let (from, to) = filters("today").window(&east).unwrap();
    let off = 120 * 60_000;
    let midnight = from.unwrap();
    assert_eq!((midnight + off) % DAY_MS, 0);
    assert!(midnight <= NOW && NOW - midnight < DAY_MS);
    assert_eq!(to, None);
}

#[test]
fn summary_and_calls_read_what_was_recorded() {
    let conn = scratch_db();
    // NOW is a fixed instant (21st of its month, UTC), so `c` three days back stays in the same month
    // on any run date and active_days differs from month_active_days.
    for (id, model, cost, file, ago) in [
        ("a", "m1", 1.0, "file", 60_000),
        ("b", "m2", 2.0, "file2", 60_000),
        ("c", "m1", 4.0, "file", 3 * DAY_MS),
    ] {
        let row = MessageRow {
            entry_id: id.into(),
            ts: NOW - ago,
            session_id: "s".into(),
            provider: "github-copilot".into(),
            model: model.into(),
            agent_type: "main".into(),
            project_label: "proj".into(),
            input: 10,
            cache_read: 90,
            total_tokens: 100,
            cost_total: cost,
            credits: Some(cost * 100.0),
            ..MessageRow::default()
        };
        assert!(record_message(&conn, file, &row).unwrap());
    }
    let f = Filters {
        model: Some("m2".into()),
        ..filters("7d")
    };
    let s = summary(&conn, &f, &ctx()).unwrap();
    assert_eq!((s.calls, s.total_tokens), (1, 100));
    assert!((s.spend_usd - 2.0).abs() < 1e-9 && (s.cache_hit_rate - 0.9).abs() < 1e-9);
    assert!((s.credits - 200.0).abs() < 1e-9);
    assert_eq!((s.active_days, s.sessions, s.month_active_days), (1, 1, 1));
    assert!((s.month_to_date_usd - 2.0).abs() < 1e-9);
    let by_project = Filters {
        project: Some("proj".into()),
        ..filters("today")
    };
    let p = summary(&conn, &by_project, &ctx()).unwrap();
    assert_eq!((p.active_days, p.sessions, p.month_active_days), (1, 2, 2));
    assert!((p.month_to_date_usd - 7.0).abs() < 1e-9);
    let wide = summary(
        &conn,
        &Filters {
            project: Some("proj".into()),
            ..filters("30d")
        },
        &ctx(),
    )
    .unwrap();
    assert_eq!(
        (wide.active_days, wide.sessions, wide.month_active_days),
        (2, 2, 2)
    );
    assert_eq!(
        (wide.month_to_date_usd, wide.month_active_days),
        (p.month_to_date_usd, p.month_active_days)
    );
    let other = Filters {
        project: Some("elsewhere".into()),
        ..filters("30d")
    };
    let o = summary(&conn, &other, &ctx()).unwrap();
    assert_eq!((o.active_days, o.sessions, o.month_active_days), (0, 0, 0));

    let page = calls(
        &conn,
        &filters("7d"),
        &Sort {
            key: "usd".into(),
            dir: "desc".into(),
        },
        Page { index: 0, size: 1 },
        &ctx(),
    )
    .unwrap();
    assert_eq!((page.total, page.rows.len()), (3, 1));
    assert_eq!(page.rows[0].model, "m1");
}

fn priced_tool_call<'a>(id: &'a str, tool: &'a str, cost_usd: f64) -> ToolCallRow<'a> {
    ToolCallRow {
        tool_call_id: id,
        entry_id: "e",
        ts: NOW - 60_000,
        tool,
        cost_usd,
        project_label: "proj",
        model: "m1",
        reasoning: "",
        agent_type: "main",
    }
}

#[test]
fn tool_cost_share_is_each_tools_fraction_of_the_window_spend() {
    let conn = scratch_db();
    for (id, tool, cost) in [("1", "bash", 3.0), ("2", "read", 1.0)] {
        record_tool_call(&conn, "file", &priced_tool_call(id, tool, cost)).unwrap();
    }
    let rows = breakdown(&conn, &filters("7d"), BreakdownBy::Tool, &ctx()).unwrap();
    let share = |tool: &str| rows.iter().find(|r| r.label == tool).unwrap().cost_share;
    assert_eq!(share("bash"), Some(0.75));
    assert_eq!(share("read"), Some(0.25));
    assert!((rows[0].usd - 3.0).abs() < 1e-9);
}

#[test]
fn tool_cost_share_is_absent_when_no_call_in_the_window_was_priced() {
    let conn = scratch_db();
    record_tool_call(&conn, "file", &priced_tool_call("1", "bash", 0.0)).unwrap();
    let rows = breakdown(&conn, &filters("7d"), BreakdownBy::Tool, &ctx()).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].cost_share, None);
}

#[test]
fn per_call_tool_breakdown_prices_and_shares_only_the_filtered_model() {
    let conn = scratch_db();
    record_tool_call(&conn, "file", &priced_tool_call("1", "bash", 3.0)).unwrap();
    record_tool_call(&conn, "file", &priced_tool_call("2", "read", 1.0)).unwrap();
    let other_model = ToolCallRow {
        model: "m2",
        ..priced_tool_call("3", "write", 4.0)
    };
    record_tool_call(&conn, "file", &other_model).unwrap();
    let f = Filters {
        model: Some("m1".into()),
        ..filters("7d")
    };
    assert!(f.needs_tool_calls());
    let rows = breakdown(&conn, &f, BreakdownBy::Tool, &ctx()).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!((rows[0].label.as_str(), rows[0].cost_share), ("bash", Some(0.75)));
    assert!((rows[0].usd - 3.0).abs() < 1e-9);
    assert_eq!(rows[1].cost_share, Some(0.25));
}

#[test]
fn tool_cost_share_divides_by_the_whole_window_when_the_listing_is_cut() {
    let conn = scratch_db();
    let tools = 501;
    for i in 0..tools {
        let (id, tool) = (format!("c{i}"), format!("tool-{i:03}"));
        record_tool_call(&conn, "file", &priced_tool_call(&id, &tool, 1.0)).unwrap();
    }
    let rows = breakdown(&conn, &filters("7d"), BreakdownBy::Tool, &ctx()).unwrap();
    assert_eq!(rows.len(), 500);
    let expected = 1.0 / tools as f64;
    assert!(rows.iter().all(|r| r.cost_share == Some(expected)));
}

#[test]
fn half_hour_zone_day_buckets_read_exact_rows() {
    let conn = scratch_db();
    let row = MessageRow {
        entry_id: "a".into(),
        ts: NOW - 60_000,
        session_id: "s".into(),
        provider: "github-copilot".into(),
        model: "m1".into(),
        agent_type: "main".into(),
        project_label: "proj".into(),
        total_tokens: 100,
        cost_total: 1.0,
        credits: Some(100.0),
        ..MessageRow::default()
    };
    assert!(record_message(&conn, "file", &row).unwrap());
    let ist = QueryCtx {
        now_ms: NOW,
        tz_offset_minutes: 330,
    };
    let buckets = timeseries(&conn, &filters("7d"), false, &ist).unwrap();
    assert_eq!(buckets.len(), 1);
    let s = summary(&conn, &filters("7d"), &ist).unwrap();
    assert_eq!((s.active_days, s.month_active_days), (1, 1));
}

#[test]
fn session_file_matches_one_conversation_and_today_matches_the_usage_view() {
    let conn = scratch_db();
    for (id, file, ago) in [
        ("a", "C:/s/a/one.jsonl", 60_000),
        ("b", "C:/s/a/two.jsonl", 60_000),
        ("c", "C:/s/a/one.jsonl", 3 * DAY_MS),
        ("d", "C:/s/a/one.jsonl.bak", 60_000),
    ] {
        let row = MessageRow {
            entry_id: id.into(),
            ts: NOW - ago,
            session_id: "s".into(),
            provider: "github-copilot".into(),
            model: "m1".into(),
            agent_type: "main".into(),
            project_label: "proj".into(),
            total_tokens: 100,
            cost_total: 1.0,
            ..MessageRow::default()
        };
        assert!(record_message(&conn, file, &row).unwrap());
    }
    // Backslashes and case differ from the stored value; the match folds both.
    let one = Filters {
        session_file: Some(r"c:\S\A\One.jsonl".into()),
        ..filters("all")
    };
    assert_eq!(summary(&conn, &one, &ctx()).unwrap().calls, 2);
    let one_today = Filters {
        session_file: Some("C:/s/a/one.jsonl".into()),
        ..filters("today")
    };
    assert_eq!(summary(&conn, &one_today, &ctx()).unwrap().calls, 1);
    let dir_today = Filters {
        session_dir: Some("C:/s/a".into()),
        ..filters("today")
    };
    assert_eq!(summary(&conn, &dir_today, &ctx()).unwrap().calls, 3);
    let empty = Filters {
        session_file: Some("  ".into()),
        ..filters("all")
    };
    assert!(matches!(
        summary(&conn, &empty, &ctx()),
        Err(QueryError::InvalidArgument(_))
    ));
}
