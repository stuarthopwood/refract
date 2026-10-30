// Spec 060 (S1-17): the filter-to-SQL builder stays parameterised and allowlisted.

use super::*;
use crate::usage::queries_tables::{calls, Page, Sort};
use crate::usage::rollup::{record_message, MessageRow};
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
    let dir = std::env::temp_dir().join(format!("refract-usage-q-{}-{nanos}", std::process::id()));
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
    for (id, model, cost) in [("a", "m1", 1.0), ("b", "m2", 2.0)] {
        let row = MessageRow {
            entry_id: id.into(),
            ts: NOW - 60_000,
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
        assert!(record_message(&conn, "file", &row).unwrap());
    }
    let f = Filters {
        model: Some("m2".into()),
        ..filters("7d")
    };
    let s = summary(&conn, &f, &ctx()).unwrap();
    assert_eq!((s.calls, s.total_tokens), (1, 100));
    assert!((s.spend_usd - 2.0).abs() < 1e-9 && (s.cache_hit_rate - 0.9).abs() < 1e-9);

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
    assert_eq!((page.total, page.rows.len()), (2, 1));
    assert_eq!(page.rows[0].model, "m2");
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
}
