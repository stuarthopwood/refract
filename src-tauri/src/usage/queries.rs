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

use super::timeutil::{hour_start, iso_date, DAY_MS};

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
        self.tz_offset_minutes.clamp(-14 * 60, 14 * 60) * 60_000
    }
}

/// Which columns of one table the filters apply to; `None` means the table lacks that column and
/// the filter is skipped. All values are `'static` literals.
pub(super) struct Target {
    pub time: &'static str,
    pub hourly: bool,
    pub project: Option<&'static str>,
    pub model: Option<&'static str>,
    pub reasoning: Option<&'static str>,
    pub agent: Option<&'static str>,
}

pub(super) const MESSAGE_ROLLUP: Target = Target {
    time: "hour",
    hourly: true,
    project: Some("project_label"),
    model: Some("model"),
    reasoning: Some("reasoning"),
    agent: Some("agent_type"),
};
pub(super) const MESSAGES: Target = Target {
    time: "ts",
    hourly: false,
    project: Some("project_label"),
    model: Some("model"),
    reasoning: Some("reasoning"),
    agent: Some("agent_type"),
};
pub(super) const TOOL_ROLLUP: Target = Target {
    time: "hour",
    hourly: true,
    project: Some("project_label"),
    model: None,
    reasoning: None,
    agent: Some("agent_type"),
};
pub(super) const TOOL_CALLS: Target = Target {
    time: "ts",
    hourly: false,
    project: Some("project_label"),
    model: Some("model"),
    reasoning: Some("reasoning"),
    agent: Some("agent_type"),
};
pub(super) const USER_MESSAGES: Target = Target {
    time: "ts",
    hourly: false,
    project: Some("project_label"),
    model: None,
    reasoning: None,
    agent: None,
};
pub(super) const SESSION_ROLLUP: Target = Target {
    time: "last_ts",
    hourly: false,
    project: Some("project_label"),
    model: None,
    reasoning: None,
    agent: None,
};

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
                (self.from, self.to)
            }
            other => {
                return Err(QueryError::InvalidArgument(format!(
                    "unknown range {other:?}"
                )))
            }
        })
    }

    pub(super) fn build(&self, target: &Target, ctx: &QueryCtx) -> QueryResult<Where> {
        if let Some(agent) = self.agent_type.as_deref() {
            if agent != "main" && agent != "subagent" {
                return Err(QueryError::InvalidArgument(format!(
                    "unknown agent type {agent:?}"
                )));
            }
        }
        let mut w = Where::default();
        let (from, to) = self.window(ctx)?;
        if let Some(from) = from {
            let from = if target.hourly {
                hour_start(from)
            } else {
                from
            };
            w.push(target.time, ">=", Value::Integer(from));
        }
        if let Some(to) = to {
            w.push(target.time, "<=", Value::Integer(to));
        }
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
    let w = f.build(&MESSAGE_ROLLUP, ctx)?;
    let sql = format!(
        "SELECT coalesce(sum(calls),0), coalesce(sum(input),0), coalesce(sum(cache_read),0), \
         coalesce(sum(cache_write),0), coalesce(sum(total_tokens),0), coalesce(sum(cost_total),0), \
         coalesce(sum(credits),0) FROM message_rollup{}",
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
        let w = f.build(&TOOL_ROLLUP, ctx)?;
        (
            format!(
                "SELECT coalesce(sum(calls),0), coalesce(sum(errors),0) FROM tool_rollup{}",
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
    let mut w = f.build(&MESSAGE_ROLLUP, ctx)?;
    let bucket = if hour_buckets {
        "hour".to_string()
    } else {
        let off = w.bind(Value::Integer(ctx.offset_ms()));
        format!("((hour + {off}) / 86400000) * 86400000 - {off}")
    };
    let sql = format!(
        "SELECT {bucket} AS b, model, sum(cost_total), sum(credits) FROM message_rollup{} \
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
    let w = f.build(&MESSAGE_ROLLUP, ctx)?;
    let sql = format!(
        "SELECT coalesce(sum(input),0), coalesce(sum(cache_write),0), coalesce(sum(cache_read),0), \
         coalesce(sum(output),0), coalesce(sum(cost_input),0), coalesce(sum(cost_cache_write),0), \
         coalesce(sum(cost_cache_read),0), coalesce(sum(cost_output),0) FROM message_rollup{}",
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
