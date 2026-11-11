// Column names come only from the `Target` constants, so a renderer value is always a bound parameter.
// `tz_offset_minutes` is minutes EAST of UTC (the negation of JS `getTimezoneOffset()`).

use rusqlite::types::Value;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::queries_session as session;
use super::timeutil::{hour_start, iso_date, DAY_MS, HOUR_MS};

/// The range names a renderer may send.
pub const RANGES: [&str; 5] = ["today", "7d", "30d", "all", "custom"];
/// The agent-type filter values.
pub const AGENT_TYPES: [&str; 3] = ["main", "subagent", "advisor"];
/// Widest time-zone offset in minutes either way.
pub const MAX_TZ_MINUTES: i64 = 14 * 60;
/// Clamp for custom `from`/`to`, in ms either side of the epoch.
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
    /// A Refract Session directory; matches every conversation file at or below it.
    pub session_dir: Option<String>,
    /// One conversation file (a `session_file` value); matches that file only.
    pub session_file: Option<String>,
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

/// Filter columns of one table; `None` means the table lacks that column and the filter is skipped.
pub(super) struct Target {
    pub time: &'static str,
    pub project: Option<&'static str>,
    pub model: Option<&'static str>,
    pub reasoning: Option<&'static str>,
    pub agent: Option<&'static str>,
    pub session: Option<&'static str>,
}

pub(super) const MESSAGE_ROLLUP: Target = Target {
    time: "hour",
    project: Some("project_label"),
    model: Some("model"),
    reasoning: Some("reasoning"),
    agent: Some("agent_type"),
    session: None,
};
pub(super) const MESSAGES: Target = Target {
    time: "ts",
    project: Some("project_label"),
    model: Some("model"),
    reasoning: Some("reasoning"),
    agent: Some("agent_type"),
    session: Some("session_file"),
};
pub(super) const TOOL_ROLLUP: Target = Target {
    time: "hour",
    project: Some("project_label"),
    model: None,
    reasoning: None,
    agent: Some("agent_type"),
    session: None,
};
pub(super) const TOOL_CALLS: Target = Target {
    time: "ts",
    project: Some("project_label"),
    model: Some("model"),
    reasoning: Some("reasoning"),
    agent: Some("agent_type"),
    session: Some("session_file"),
};
pub(super) const USER_MESSAGES: Target = Target {
    time: "ts",
    project: Some("project_label"),
    model: None,
    reasoning: None,
    agent: None,
    session: Some("session_file"),
};
pub(super) const SESSION_ROLLUP: Target = Target {
    time: "last_ts",
    project: Some("project_label"),
    model: None,
    reasoning: None,
    agent: None,
    session: Some("session_file"),
};

/// Rollup table and per-call table backing its exact edges.
#[derive(Clone, Copy)]
pub(super) enum Rollup {
    Messages,
    Tools,
}

impl Rollup {
    /// Rollup table, its columns, per-call table, and per-call select list after the hour.
    fn parts(self) -> (&'static str, &'static str, &'static str, &'static str) {
        match self {
            Self::Messages => (
                "message_rollup",
                "hour, project_label, model, reasoning, agent_type, calls, input, output, \
                 cache_read, cache_write, total_tokens, cost_total, cost_input, cost_output, \
                 cost_cache_read, cost_cache_write, credits",
                "messages",
                "project_label, model, reasoning, agent_type, 1 AS calls, input, output, cache_read, \
                 cache_write, total_tokens, cost_total, cost_input, cost_output, cost_cache_read, \
                 cost_cache_write, coalesce(credits, 0) AS credits",
            ),
            Self::Tools => (
                "tool_rollup",
                "hour, project_label, tool, agent_type, calls, errors, result_chars, cost_usd",
                "tool_calls",
                "project_label, tool, agent_type, 1 AS calls, coalesce(is_error, 0) AS errors, result_chars, cost_usd",
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

    /// Project, model, reasoning and agent-type filters only, with no time bound.
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
        if let Some(clause) = self.session_clause(&mut w, target.session)? {
            w.clauses.push(clause);
        }
        Ok(w)
    }

    fn session_clause(&self, w: &mut Where, column: Option<&str>) -> QueryResult<Option<String>> {
        let Some(column) = column else {
            return Ok(None);
        };
        let mut parts = Vec::new();
        if let Some(dir) = self.session_dir.as_deref() {
            parts.push(session::clause(w, dir, column)?);
        }
        if let Some(file) = self.session_file.as_deref() {
            parts.push(session::file_clause(w, file, column)?);
        }
        Ok((!parts.is_empty()).then(|| parts.join(" AND ")))
    }

    /// True when a Session directory or one conversation file narrows the query.
    fn session_scoped(&self) -> bool {
        self.session_dir.is_some() || self.session_file.is_some()
    }

    /// Checks the allowlists and that a custom range is not inverted. `ipc/usage.rs` calls it too.
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
        if let Some(dir) = self.session_dir.as_deref() {
            session::normalise(dir)?;
        }
        if let Some(file) = self.session_file.as_deref() {
            session::normalise(file)?;
        }
        Ok(())
    }

    /// Rollup table (or union) to read instead of the raw rollup. Partial edge hours come from the
    /// per-call table so cards match the call log; `exact` reads per-call rows for all buckets.
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
        // The rollups carry no session column, so a Session or conversation filter reads the per-call rows.
        if exact || self.session_scoped() {
            let mut c = bounds(w, "ts");
            c.extend(self.session_clause(w, Some("session_file"))?);
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
        // Whole hours [r_lo, r_hi) come from the rollup; the rest of the window comes from rows.
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

    /// True when a model, reasoning, Session or conversation filter forces the per-call tool table.
    pub(super) fn needs_tool_calls(&self) -> bool {
        self.model.is_some() || self.reasoning.is_some() || self.session_scoped()
    }
}

/// Day buckets in a half-hour zone need exact timestamps, not hour rollups.
pub(super) fn exact_day_rows(ctx: &QueryCtx) -> bool {
    ctx.offset_ms() % HOUR_MS != 0
}

/// SQL expression for the local-day bucket start of `hour`; shared so chart and averages agree.
pub(super) fn day_bucket(w: &mut Where, ctx: &QueryCtx) -> String {
    let off = w.bind(Value::Integer(ctx.offset_ms()));
    format!("((hour + {off}) / 86400000) * 86400000 - {off}")
}

pub(super) fn ratio(n: f64, d: f64) -> f64 {
    if d > 0.0 {
        n / d
    } else {
        0.0
    }
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
    let exact = !hour_buckets && exact_day_rows(ctx);
    let src = f.rollup_source(&mut w, Rollup::Messages, ctx, exact)?;
    let bucket = if hour_buckets {
        "hour".to_string()
    } else {
        day_bucket(&mut w, ctx)
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
