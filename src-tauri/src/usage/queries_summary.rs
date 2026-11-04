// Headline totals and the Averages inputs, split from `queries.rs` for the 600-line cap.

use rusqlite::Connection;
use serde::Serialize;

use super::queries::{
    day_bucket, exact_day_rows, ratio, Filters, QueryCtx, QueryResult, Rollup, MESSAGES,
    MESSAGE_ROLLUP, TOOL_CALLS, TOOL_ROLLUP,
};
use super::timeutil::month_start_local;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub spend_usd: f64,
    pub credits: f64,
    pub calls: i64,
    pub total_tokens: i64,
    pub cache_hit_rate: f64,
    pub avg_context_per_call: f64,
    pub tool_calls: i64,
    pub tool_error_rate: f64,
    /// Local days with at least one call in the filtered window.
    pub active_days: i64,
    /// Distinct session files with a call in the filtered window.
    pub sessions: i64,
    /// Spend since the start of the local month; ignores the caller's date range.
    pub month_to_date_usd: f64,
    pub month_active_days: i64,
}

/// `(spend, active local days)` over the filtered rollup, using the chart's day buckets.
fn spend_and_days(conn: &Connection, f: &Filters, ctx: &QueryCtx) -> QueryResult<(f64, i64)> {
    let mut w = f.build_dims(&MESSAGE_ROLLUP, ctx)?;
    let src = f.rollup_source(&mut w, Rollup::Messages, ctx, exact_day_rows(ctx))?;
    let bucket = day_bucket(&mut w, ctx);
    let sql = format!(
        "SELECT coalesce(sum(cost_total),0), count(DISTINCT CASE WHEN calls > 0 THEN {bucket} END) \
         FROM {src}{}",
        w.sql()
    );
    Ok(
        conn.query_row(&sql, rusqlite::params_from_iter(w.params()), |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?,
    )
}

fn session_count(conn: &Connection, f: &Filters, ctx: &QueryCtx) -> QueryResult<i64> {
    let w = f.build(&MESSAGES, ctx)?;
    let sql = format!(
        "SELECT count(DISTINCT session_file) FROM messages{}",
        w.sql()
    );
    Ok(conn.query_row(&sql, rusqlite::params_from_iter(w.params()), |r| r.get(0))?)
}

pub fn summary(conn: &Connection, f: &Filters, ctx: &QueryCtx) -> QueryResult<Summary> {
    let mut w = f.build_dims(&MESSAGE_ROLLUP, ctx)?;
    let src = f.rollup_source(&mut w, Rollup::Messages, ctx, false)?;
    let sql = format!(
        "SELECT coalesce(sum(calls),0), coalesce(sum(input),0), coalesce(sum(cache_read),0), \
         coalesce(sum(cache_write),0), coalesce(sum(total_tokens),0), coalesce(sum(cost_total),0), \
         coalesce(sum(credits),0) FROM {src}{}",
        w.sql()
    );
    let v: [f64; 7] = conn.query_row(&sql, rusqlite::params_from_iter(w.params()), |r| {
        let mut out = [0.0; 7];
        for (i, slot) in out.iter_mut().enumerate() {
            *slot = r.get(i)?;
        }
        Ok(out)
    })?;
    let [calls, input, cache_read, cache_write, tokens, usd, credits] = v;
    let (tool_calls, tool_errors) = tool_totals(conn, f, ctx)?;
    let context = input + cache_read + cache_write;
    let (_, active_days) = spend_and_days(conn, f, ctx)?;
    // Only the date range is dropped; Project, model, reasoning, agent type and Session stay.
    let month = Filters {
        range: "custom".into(),
        from: Some(month_start_local(ctx.now_ms, ctx.offset_ms())),
        to: None,
        ..f.clone()
    };
    let (month_to_date_usd, month_active_days) = spend_and_days(conn, &month, ctx)?;
    Ok(Summary {
        spend_usd: usd,
        credits,
        calls: calls as i64,
        total_tokens: tokens as i64,
        cache_hit_rate: ratio(cache_read, context),
        avg_context_per_call: ratio(context, calls),
        tool_calls,
        tool_error_rate: ratio(tool_errors as f64, tool_calls as f64),
        active_days,
        sessions: session_count(conn, f, ctx)?,
        month_to_date_usd,
        month_active_days,
    })
}

/// `(calls, errors)` over the filtered tool calls. Errors count only calls whose result arrived.
fn tool_totals(conn: &Connection, f: &Filters, ctx: &QueryCtx) -> QueryResult<(i64, i64)> {
    let (sql, w) = if f.needs_tool_calls() {
        let w = f.build(&TOOL_CALLS, ctx)?;
        (
            format!(
                "SELECT count(*), coalesce(sum(coalesce(is_error,0)),0) FROM tool_calls{}",
                w.sql()
            ),
            w,
        )
    } else {
        let mut w = f.build_dims(&TOOL_ROLLUP, ctx)?;
        let src = f.rollup_source(&mut w, Rollup::Tools, ctx, false)?;
        (
            format!(
                "SELECT coalesce(sum(calls),0), coalesce(sum(errors),0) FROM {src}{}",
                w.sql()
            ),
            w,
        )
    };
    Ok(
        conn.query_row(&sql, rusqlite::params_from_iter(w.params()), |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?,
    )
}
