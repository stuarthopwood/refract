// #1847: the 14d, mtd and ytd ranges. Bounds are local midnights derived from the request's offset.

use super::*;
use crate::usage::timeutil::parse_iso_ms;

fn at(iso: &str) -> i64 {
    parse_iso_ms(iso).unwrap()
}

fn ctx_at(iso: &str, tz_offset_minutes: i64) -> QueryCtx {
    QueryCtx {
        now_ms: at(iso),
        tz_offset_minutes,
    }
}

fn from_of(range: &str, ctx: &QueryCtx) -> i64 {
    let (from, to) = filters(range).window(ctx).unwrap();
    assert_eq!(to, None, "{range} is open-ended");
    from.unwrap()
}

fn record_at(conn: &Connection, id: &str, iso: &str) {
    let row = MessageRow {
        entry_id: id.into(),
        ts: at(iso),
        session_id: "s".into(),
        provider: "github-copilot".into(),
        model: "m1".into(),
        agent_type: "main".into(),
        project_label: "proj".into(),
        total_tokens: 100,
        cost_total: 1.0,
        ..MessageRow::default()
    };
    assert!(record_message(conn, "file", &row).unwrap());
}

#[test]
fn every_range_the_tabs_send_passes_validation() {
    for range in RANGES {
        assert!(filters(range).validate().is_ok(), "{range}");
    }
}

#[test]
fn fourteen_days_reaches_back_exactly_fourteen_days() {
    let ctx = ctx_at("2026-11-26T12:00:00Z", 0);
    assert_eq!(from_of("14d", &ctx), ctx.now_ms - 14 * DAY_MS);
}

#[test]
fn mtd_starts_at_local_midnight_on_the_first() {
    assert_eq!(
        from_of("mtd", &ctx_at("2026-11-26T12:00:00Z", 0)),
        at("2026-11-01T00:00:00Z")
    );
    // Two hours east: local 1 November 00:00 is still 31 October in UTC.
    assert_eq!(
        from_of("mtd", &ctx_at("2026-11-26T12:00:00Z", 120)),
        at("2026-10-31T22:00:00Z")
    );
}

#[test]
fn ytd_starts_at_local_midnight_on_1_january() {
    assert_eq!(
        from_of("ytd", &ctx_at("2026-11-26T12:00:00Z", 0)),
        at("2026-01-01T00:00:00Z")
    );
    assert_eq!(
        from_of("ytd", &ctx_at("2026-11-26T12:00:00Z", 330)),
        at("2025-12-31T18:30:00Z")
    );
}

#[test]
fn ytd_follows_the_local_year_when_utc_has_already_rolled_over() {
    // 00:30 UTC on 1 Jan 2026 is still 31 Dec 2025 at UTC-5, so the local year is 2025.
    assert_eq!(
        from_of("ytd", &ctx_at("2026-01-01T00:30:00Z", -300)),
        at("2025-01-01T05:00:00Z")
    );
}

#[test]
fn mtd_on_the_first_equals_today() {
    for offset in [0, 120, -300, 330, -570] {
        let ctx = ctx_at("2026-12-01T10:00:00Z", offset);
        assert_eq!(
            from_of("mtd", &ctx),
            from_of("today", &ctx),
            "offset {offset}"
        );
    }
}

#[test]
fn ytd_on_1_january_equals_today() {
    for offset in [0, 120, -300, 330, -570] {
        let ctx = ctx_at("2027-01-01T10:00:00Z", offset);
        assert_eq!(
            from_of("ytd", &ctx),
            from_of("today", &ctx),
            "offset {offset}"
        );
    }
}

#[test]
fn bounds_use_the_offset_the_request_carries_across_a_dst_change() {
    // London in July is UTC+1. Like `today` and the month-to-date card, the bound uses that current
    // offset for the whole year, because the renderer sends one offset per request.
    assert_eq!(
        from_of("ytd", &ctx_at("2026-07-10T12:00:00Z", 60)),
        at("2025-12-31T23:00:00Z")
    );
}

#[test]
fn ytd_reads_the_whole_hour_rollup_in_a_whole_hour_zone() {
    let conn = scratch_db();
    record_at(&conn, "a", "2025-12-31T23:59:00Z");
    record_at(&conn, "b", "2026-01-01T00:00:00Z");
    record_at(&conn, "c", "2026-01-01T00:30:00Z");
    let ctx = ctx_at("2026-03-10T12:00:00Z", 0);
    assert_eq!(summary(&conn, &filters("ytd"), &ctx).unwrap().calls, 2);
}

#[test]
fn ytd_splits_the_edge_hour_in_a_half_hour_zone() {
    let conn = scratch_db();
    // The 18:00 UTC hour straddles IST midnight (18:30 UTC): only the 18:45 call is in the year.
    record_at(&conn, "a", "2025-12-31T18:10:00Z");
    record_at(&conn, "b", "2025-12-31T18:45:00Z");
    record_at(&conn, "c", "2025-12-31T19:15:00Z");
    let ctx = ctx_at("2026-03-10T12:00:00Z", 330);
    let s = summary(&conn, &filters("ytd"), &ctx).unwrap();
    assert_eq!((s.calls, s.spend_usd), (2, 2.0));
}
