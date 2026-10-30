// Spec 060 (S1-11): the read side of `usage.db`. A `Filters` value becomes a bound-parameter
// `WHERE` through `Filters::build`; column names come only from the `Target` constants below, never
// from the caller, so a renderer value can only ever be a bound parameter. Cards, charts and the
// by-* tables read the rollups; the per-call log reads `messages` (see `queries_tables`).
//
// `tz_offset_minutes` is minutes EAST of UTC (the negation of JS `getTimezoneOffset()`); it moves
// "today" and the day buckets to the viewer's local midnight.

use rusqlite::types::Value;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::timeutil::{hour_start, iso_date, DAY_MS, HOUR_MS};

/// The range names a renderer may send.
pub const RANGES: [&str; 5] = ["today", "7d", "30d", "all", "custom"];
/// The agent-type filter values.
pub const AGENT_TYPES: [&str; 2] = ["main", "subagent"];
/// The widest time-zone offset in minutes either way (UTC+14 / UTC-12 round up to this).
pub const MAX_TZ_MINUTES: i64 = 14 * 60;
/// A custom `from` or `to` is clamped to this many ms either side of the epoch.
const MAX_CUSTOM_MS: i64 = 1_000_000_000_000_000;

#[derive(Debug, thiserror::Error)]
pub enum QueryError {
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    #[error("usage db: {0}")]
    Db(#[from] rusqlite::Error),
}

pub type QueryResult<T> = Result<T, QueryError>;

/// Renderer-supplied filters (`UsageFilters` in the contract).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Filters {
    pub range: String,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub project: Option<String>,
    pub model: Option<String>,
    pub reasoning: Option<String>,
    pub agent_type: Option<String>,
}

/// The clock and time zone a query runs in.
#[derive(Debug, Clone, Copy)]
pub struct QueryCtx {
    pub now_ms: i64,
    pub tz_offset_minutes: i64,
}

impl QueryCtx {
    pub fn offset_ms(&self) -> i64 {
        self.tz_offset_minutes
            .clamp(-MAX_TZ_MINUTES, MAX_TZ_MINUTES)
            * 60_000
    }
}

/// Which columns of one table the filters apply to; `None` means the table lacks that column and
/// the filter is skipped. All values are `'static` literals.
pub(super) struct Target {
    pub time: &'static str,
    pub project: Option<&'static str>,
    pub model: Option<&'static str>,
    pub reasoning: Option<&'static str>,
    pub agent: Option<&'static str>,
}

pub(super) const MESSAGE_ROLLUP: Target = Target {
    time: "hour",
    project: Some("project_label"),
    model: Some("model"),
    reasoning: Some("reasoning"),
    agent: Some("agent_type"),
};
pub(super) const MESSAGES: Target = Target {
    time: "ts",
    project: Some("project_label"),
    model: Some("model"),
    reasoning: Some("reasoning"),
    agent: Some("agent_type"),
};
pub(super) const TOOL_ROLLUP: Target = Target {
    time: "hour",
    project: Some("project_label"),
    model: None,
    reasoning: None,
    agent: Some("agent_type"),
};
pub(super) const TOOL_CALLS: Target = Target {
    time: "ts",
    project: Some("project_label"),
    model: Some("model"),
    reasoning: Some("reasoning"),
    agent: Some("agent_type"),
};
pub(super) const USER_MESSAGES: Target = Target {
    time: "ts",
    project: Some("project_label"),
    model: None,
    reasoning: None,
    agent: None,
};
pub(super) const SESSION_ROLLUP: Target = Target {
    time: "last_ts",
    project: Some("project_label"),
    model: None,
    reasoning: None,
    agent: None,
};

/// Which rollup table `rollup_source` reads, and the per-call table that backs its exact edges.
#[derive(Clone, Copy)]
pub(super) enum Rollup {
    Messages,
    Tools,
}

impl Rollup {
    /// `(rollup table, its columns, per-call table, per-call select list after the hour)`; the
    /// select list yields the rollup's columns, in order, for one call.
    fn parts(self) -> (&'static str, &'static str, &'static str, &'static str) {
        match self {
            Self::Messages => (
                "message_rollup",
                "hour, project_label, model, reasoning, agent_type, calls, input, output, \
                 cache_read, cache_write, total_tokens, cost_total, cost_input, cost_output, \
                 cost_cache_read, cost_cache_write, credits",
                "messages",
                "project_label, model, reasoning, agent_type, 1, input, output, cache_read, \
                 cache_write, total_tokens, cost_total, cost_input, cost_output, cost_cache_read, \
                 cost_cache_write, coalesce(credits, 0)",
            ),
            Self::Tools => (
                "tool_rollup",
                "hour, project_label, tool, agent_type, calls, errors, result_chars, cost_share",
                "tool_calls",
                "project_label, tool, agent_type, 1, coalesce(is_error, 0), result_chars, cost_share",
            ),
        }
    }
}

/// A `WHERE` clause with numbered `?N` placeholders and their values.
#[derive(Default)]
pub(super) struct Where {
    clauses: Vec<String>,
    args: Vec<Value>,
}

impl Where {
    /// Adds a value and returns its placeholder.
    pub(super) fn bind(&mut self, value: Value) -> String {
        self.args.push(value);
        format!("?{}", self.args.len())
    }

    fn push(&mut self, column: &str, op: &str, value: Value) {
        let placeholder = self.bind(value);
        self.clauses.push(format!("{column} {op} {placeholder}"));
    }

    pub(super) fn sql(&self) -> String {
        if self.clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", self.clauses.join(" AND "))
        }
    }

    pub(super) fn params(&self) -> impl Iterator<Item = &Value> {
        self.args.iter()
    }
}

impl Filters {
    /// `[from, to]` in ms; `None` is open-ended. Rejects an unknown range or `from > to`.
    pub fn window(&self, ctx: &QueryCtx) -> QueryResult<(Option<i64>, Option<i64>)> {
        let now = ctx.now_ms;
        Ok(match self.range.as_str() {
            "today" => {
                let off = ctx.offset_ms();
                (Some((now + off).div_euclid(DAY_MS) * DAY_MS - off), None)
            }
            "7d" => (Some(now - 7 * DAY_MS), None),
            "30d" => (Some(now - 30 * DAY_MS), None),
            "all" => (None, None),
            "custom" => {
                if let (Some(from), Some(to)) = (self.from, self.to) {
                    if from > to {
                        return Err(QueryError::InvalidArgument("from is after to".into()));
                    }
                }
                (
                    self.from.map(|v| v.clamp(-MAX_CUSTOM_MS, MAX_CUSTOM_MS)),
                    self.to.map(|v| v.clamp(-MAX_CUSTOM_MS, MAX_CUSTOM_MS)),
                )
            }
            other => {
                return Err(QueryError::InvalidArgument(format!(
                    "unknown range {other:?}"
                )))
            }
        })
    }

    pub(super) fn build(&self, target: &Target, ctx: &QueryCtx) -> QueryResult<Where> {
        let mut w = self.build_dims(target, ctx)?;
        let (from, to) = self.window(ctx)?;
        if let Some(from) = from {
            w.push(target.time, ">=", Value::Integer(from));
        }
        if let Some(to) = to {
            w.push(target.time, "<=", Value::Integer(to));
        }
        Ok(w)
    }

    /// The Project, model, reasoning and agent-type filters only, no time bound. Rollup queries
    /// take their time bound from `rollup_source` instead.
    pub(super) fn build_dims(&self, target: &Target, ctx: &QueryCtx) -> QueryResult<Where> {
        self.validate()?;
        self.window(ctx)?;
        let mut w = Where::default();
        let pairs = [
            (target.project, &self.project),
            (target.model, &self.model),
            (target.reasoning, &self.reasoning),
            (target.agent, &self.agent_type),
        ];
        for (column, value) in pairs {
            if let (Some(column), Some(value)) = (column, value.as_deref()) {
                w.push(column, "=", Value::Text(value.to_string()));
            }
        }
        Ok(w)
    }

    /// Checks the range and agent-type allowlists and that a custom range is not inverted. The one
    /// place these rules live; `ipc/usage.rs` calls it too.
    pub fn validate(&self) -> QueryResult<()> {
        if !RANGES.contains(&self.range.as_str()) {
            return Err(QueryError::InvalidArgument(format!(
                "unknown range {:?}",
                self.range
            )));
        }
        if let Some(agent) = self.agent_type.as_deref() {
            if !AGENT_TYPES.contains(&agent) {
                return Err(QueryError::InvalidArgument(format!(
                    "unknown agent type {agent:?}"
                )));
            }
        }
        if let (Some(from), Some(to)) = (self.from, self.to) {
            if self.range == "custom" && from > to {
                return Err(QueryError::InvalidArgument("from is after to".into()));
            }
        }
        Ok(())
    }

    /// The rollup table (or a union that makes it exact) to read in place of `message_rollup` or
    /// `tool_rollup`. A rollup row is a whole UTC hour, so a window edge inside an hour would
    /// otherwise pull in or drop part of that hour. When an edge is not hour-aligned (a rolling 7d
    /// or 30d, a half-hour time zone's midnight, a custom range) the whole hours come from the
    /// rollup and the partial edge hours come from the per-call table by exact timestamp, so cards
    /// agree with the call log. With `exact` every row comes from the per-call table with its exact
    /// timestamp in `hour` (used for day buckets in a time zone that is not a whole number of hours).
    /// Values are bound into `w`; the filters from `build_dims` go in the outer `WHERE`.
    pub(super) fn rollup_source(
        &self,
        w: &mut Where,
        kind: Rollup,
        ctx: &QueryCtx,
        exact: bool,
    ) -> QueryResult<String> {
        let (from, to) = self.window(ctx)?;
        let (table, cols, fact, rest) = kind.parts();
        let hour_expr = "ts - ts % 3600000";
        let bounds = |w: &mut Where, col: &str| -> Vec<String> {
            let mut c = Vec::new();
            if let Some(from) = from {
                c.push(format!("{col} >= {}", w.bind(Value::Integer(from))));
            }
            if let Some(to) = to {
                c.push(format!("{col} <= {}", w.bind(Value::Integer(to))));
            }
            c
        };
        let clause = |c: &[String]| {
            if c.is_empty() {
                String::new()
            } else {
                format!(" WHERE {}", c.join(" AND "))
            }
        };
        if exact {
            let c = bounds(w, "ts");
            return Ok(format!(
                "(SELECT ts AS hour, {rest} FROM {fact}{})",
                clause(&c)
            ));
        }
        let lo_partial = from.is_some_and(|f| f.rem_euclid(HOUR_MS) != 0);
        let hi_partial = to.is_some_and(|t| (t + 1).rem_euclid(HOUR_MS) != 0);
        if !lo_partial && !hi_partial {
            let c = bounds(w, "hour");
            return Ok(format!("(SELECT {cols} FROM {table}{})", clause(&c)));
        }
        // Whole hours [r_lo, r_hi) come from the rollup; everything else in the window from rows.
        let mut rollup_c = Vec::new();
        let mut edge = Vec::new();
        let mut fact_c = bounds(w, "ts");
        if let Some(from) = from {
            let r_lo = from + (HOUR_MS - from.rem_euclid(HOUR_MS)) % HOUR_MS;
            let ph = w.bind(Value::Integer(r_lo));
            rollup_c.push(format!("hour >= {ph}"));
            edge.push(format!("{hour_expr} < {ph}"));
        }
        if let Some(to) = to {
            let r_hi = hour_start(to + 1);
            let ph = w.bind(Value::Integer(r_hi));
            rollup_c.push(format!("hour < {ph}"));
            edge.push(format!("{hour_expr} >= {ph}"));
        }
        fact_c.push(format!("({})", edge.join(" OR ")));
        Ok(format!(
            "(SELECT {cols} FROM {table}{} UNION ALL SELECT {hour_expr} AS hour, {rest} FROM {fact}{})",
            clause(&rollup_c),
            clause(&fact_c)
        ))
    }

    /// True when a model or reasoning filter forces the per-call tool table (the tool rollup has
    /// neither column).
    fn needs_tool_calls(&self) -> bool {
        self.model.is_some() || self.reasoning.is_some()
    }
}

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
}

fn ratio(n: f64, d: f64) -> f64 {
    if d > 0.0 {
        n / d
    } else {
        0.0
    }
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
    Ok(Summary {
        spend_usd: usd,
        credits,
        calls: calls as i64,
        total_tokens: tokens as i64,
        cache_hit_rate: ratio(cache_read, context),
        avg_context_per_call: ratio(context, calls),
        tool_calls,
        tool_error_rate: ratio(tool_errors as f64, tool_calls as f64),
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

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpend {
    pub model: String,
    pub usd: f64,
    pub credits: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeBucket {
    pub bucket_start: i64,
    pub by_model: Vec<ModelSpend>,
}

/// Spend per bucket stacked by model. `hour_buckets` selects hourly buckets; otherwise local days.
pub fn timeseries(
    conn: &Connection,
    f: &Filters,
    hour_buckets: bool,
    ctx: &QueryCtx,
) -> QueryResult<Vec<TimeBucket>> {
    let mut w = f.build_dims(&MESSAGE_ROLLUP, ctx)?;
    // Day buckets in a half-hour zone need exact timestamps; whole-hour zones can use hours.
    let exact = !hour_buckets && ctx.offset_ms() % HOUR_MS != 0;
    let src = f.rollup_source(&mut w, Rollup::Messages, ctx, exact)?;
    let bucket = if hour_buckets {
        "hour".to_string()
    } else {
        let off = w.bind(Value::Integer(ctx.offset_ms()));
        format!("((hour + {off}) / 86400000) * 86400000 - {off}")
    };
    let sql = format!(
        "SELECT {bucket} AS b, model, sum(cost_total), sum(credits) FROM {src}{} \
         GROUP BY b, model ORDER BY b, model",
        w.sql()
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(w.params()), |r| {
        Ok((
            r.get::<_, i64>(0)?,
            ModelSpend {
                model: r.get(1)?,
                usd: r.get(2)?,
                credits: r.get(3)?,
            },
        ))
    })?;
    let mut out: Vec<TimeBucket> = Vec::new();
    for row in rows {
        let (start, spend) = row?;
        match out.last_mut() {
            Some(last) if last.bucket_start == start => last.by_model.push(spend),
            _ => out.push(TimeBucket {
                bucket_start: start,
                by_model: vec![spend],
            }),
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenMixRow {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub tokens: i64,
    pub usd: f64,
    pub cost_share: f64,
}

pub fn token_mix(conn: &Connection, f: &Filters, ctx: &QueryCtx) -> QueryResult<Vec<TokenMixRow>> {
    let mut w = f.build_dims(&MESSAGE_ROLLUP, ctx)?;
    let src = f.rollup_source(&mut w, Rollup::Messages, ctx, false)?;
    let sql = format!(
        "SELECT coalesce(sum(input),0), coalesce(sum(cache_write),0), coalesce(sum(cache_read),0), \
         coalesce(sum(output),0), coalesce(sum(cost_input),0), coalesce(sum(cost_cache_write),0), \
         coalesce(sum(cost_cache_read),0), coalesce(sum(cost_output),0) FROM {src}{}",
        w.sql()
    );
    let v: [f64; 8] = conn.query_row(&sql, rusqlite::params_from_iter(w.params()), |r| {
        let mut out = [0.0; 8];
        for (i, slot) in out.iter_mut().enumerate() {
            *slot = r.get(i)?;
        }
        Ok(out)
    })?;
    let total: f64 = v[4..].iter().sum();
    let kinds = ["input", "cacheWrite", "cacheRead", "output"];
    Ok(kinds
        .iter()
        .enumerate()
        .map(|(i, &kind)| TokenMixRow {
            kind,
            tokens: v[i] as i64,
            usd: v[4 + i],
            cost_share: ratio(v[4 + i], total),
        })
        .collect())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoodDay {
    pub day: String,
    pub mood: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrustrationReport {
    pub yelling: i64,
    pub profanity: i64,
    pub blame: i64,
    pub messages: i64,
    pub daily: Vec<MoodDay>,
}

/// Frustration counts over real user messages. Only the time range and Project filter apply.
pub fn frustration(
    conn: &Connection,
    f: &Filters,
    ctx: &QueryCtx,
) -> QueryResult<FrustrationReport> {
    let mut w = f.build(&USER_MESSAGES, ctx)?;
    let sql = format!(
        "SELECT coalesce(sum(yelling),0), coalesce(sum(profanity),0), coalesce(sum(blame),0), count(*) \
         FROM user_messages{}",
        w.sql()
    );
    let (yelling, profanity, blame, messages) =
        conn.query_row(&sql, rusqlite::params_from_iter(w.params()), |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?;
    let off_ms = ctx.offset_ms();
    let off = w.bind(Value::Integer(off_ms));
    let sql = format!(
        "SELECT (ts + {off}) / 86400000 AS d, sum(yelling + profanity + blame) * 1.0 / count(*) \
         FROM user_messages{} GROUP BY d ORDER BY d",
        w.sql()
    );
    let mut stmt = conn.prepare(&sql)?;
    let daily = stmt
        .query_map(rusqlite::params_from_iter(w.params()), |r| {
            Ok(MoodDay {
                day: iso_date(r.get::<_, i64>(0)? * DAY_MS),
                mood: r.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(FrustrationReport {
        yelling,
        profanity,
        blame,
        messages,
        daily,
    })
}

#[cfg(test)]
#[path = "queries.test.rs"]
mod tests;
