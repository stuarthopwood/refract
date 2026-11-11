// Sort keys and group-by choices map to fixed column names; renderer strings never reach SQL.

use rusqlite::types::Value;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::queries::{
    Filters, QueryCtx, QueryError, QueryResult, Rollup, MESSAGES, MESSAGE_ROLLUP, SESSION_ROLLUP,
    TOOL_CALLS, TOOL_ROLLUP,
};

const BREAKDOWN_LIMIT: i64 = 500;
const TOP_SESSIONS: i64 = 10;
pub const MAX_PAGE_SIZE: i64 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BreakdownBy {
    Project,
    Model,
    Tool,
}

impl BreakdownBy {
    pub fn parse(text: &str) -> QueryResult<Self> {
        match text {
            "project" => Ok(Self::Project),
            "model" => Ok(Self::Model),
            "tool" => Ok(Self::Tool),
            other => Err(QueryError::InvalidArgument(format!(
                "unknown breakdown {other:?}"
            ))),
        }
    }
}

/// One row of the breakdown tables.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakdownRow {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    pub calls: i64,
    pub tokens: i64,
    pub usd: f64,
    pub credits: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errors: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_chars: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_share: Option<f64>,
}

pub fn breakdown(
    conn: &Connection,
    f: &Filters,
    by: BreakdownBy,
    ctx: &QueryCtx,
) -> QueryResult<Vec<BreakdownRow>> {
    match by {
        BreakdownBy::Project | BreakdownBy::Model => {
            let mut w = f.build_dims(&MESSAGE_ROLLUP, ctx)?;
            let src = f.rollup_source(&mut w, Rollup::Messages, ctx, false)?;
            let (select, group) = if by == BreakdownBy::Project {
                ("project_label, ''", "project_label")
            } else {
                ("model, reasoning", "model, reasoning")
            };
            let sql = format!(
                "SELECT {select}, sum(calls), sum(total_tokens), sum(cost_total), sum(credits) \
                 FROM {src}{} GROUP BY {group} \
                 ORDER BY sum(cost_total) DESC, sum(calls) DESC, 1 LIMIT {BREAKDOWN_LIMIT}",
                w.sql()
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params_from_iter(w.params()), |r| {
                let reasoning: String = r.get(1)?;
                Ok(BreakdownRow {
                    label: r.get(0)?,
                    reasoning: (by == BreakdownBy::Model).then_some(reasoning),
                    calls: r.get(2)?,
                    tokens: r.get(3)?,
                    usd: r.get(4)?,
                    credits: r.get(5)?,
                    errors: None,
                    result_chars: None,
                    cost_share: None,
                })
            })?;
            Ok(rows.collect::<Result<_, _>>()?)
        }
        BreakdownBy::Tool => tool_breakdown(conn, f, ctx),
    }
}

fn tool_breakdown(
    conn: &Connection,
    f: &Filters,
    ctx: &QueryCtx,
) -> QueryResult<Vec<BreakdownRow>> {
    let per_call = f.needs_tool_calls();
    let (w, cols, from) = if per_call {
        (
            f.build(&TOOL_CALLS, ctx)?,
            "tool, count(*), coalesce(sum(coalesce(is_error,0)),0), \
             coalesce(sum(result_chars),0), coalesce(sum(cost_usd),0)",
            "tool_calls".to_string(),
        )
    } else {
        let mut w = f.build_dims(&TOOL_ROLLUP, ctx)?;
        let src = f.rollup_source(&mut w, Rollup::Tools, ctx, false)?;
        (
            w,
            "tool, sum(calls), sum(errors), sum(result_chars), sum(cost_usd)",
            src,
        )
    };
    let sql = format!(
        "SELECT {cols} FROM {from}{} GROUP BY tool ORDER BY 5 DESC, 2 DESC, tool LIMIT {BREAKDOWN_LIMIT}",
        w.sql()
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt
        .query_map(rusqlite::params_from_iter(w.params()), |r| {
            Ok(BreakdownRow {
                label: r.get(0)?,
                reasoning: None,
                calls: r.get(1)?,
                tokens: 0,
                usd: r.get(4)?,
                credits: 0.0,
                errors: Some(r.get(2)?),
                result_chars: Some(r.get(3)?),
                cost_share: None,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    // The listing is cut at BREAKDOWN_LIMIT, so the denominator is summed over the whole window.
    let total: f64 = conn.query_row(
        &format!("SELECT coalesce(sum(cost_usd), 0) FROM {from}{}", w.sql()),
        rusqlite::params_from_iter(w.params()),
        |r| r.get(0),
    )?;
    fill_cost_share(&mut rows, total);
    Ok(rows)
}

/// Each tool's fraction of the window's tool spend; left unset when nothing was priced.
fn fill_cost_share(rows: &mut [BreakdownRow], total: f64) {
    if total > 0.0 {
        for row in rows {
            row.cost_share = Some(row.usd / total);
        }
    }
}

/// A top-ten session row.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopSession {
    pub session_id: String,
    pub label: String,
    pub project: String,
    pub usd: f64,
    pub credits: f64,
    pub calls: i64,
    #[serde(skip)]
    pub session_file: String,
}

fn short_label(session_id: &str, session_file: &str) -> String {
    let base = if session_id.is_empty() {
        std::path::Path::new(session_file)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default()
    } else {
        session_id.to_string()
    };
    base.chars().take(8).collect()
}

pub fn top_sessions(
    conn: &Connection,
    f: &Filters,
    ctx: &QueryCtx,
) -> QueryResult<Vec<TopSession>> {
    // The per-session rollup has no time columns, so it answers only "all time".
    let from_rollup =
        f.range == "all" && f.model.is_none() && f.reasoning.is_none() && f.agent_type.is_none();
    let (w, body) = if from_rollup {
        (
            f.build(&SESSION_ROLLUP, ctx)?,
            "SELECT session_file, session_id, project_label, cost_total, credits, calls FROM session_rollup",
        )
    } else {
        (
            f.build(&MESSAGES, ctx)?,
            "SELECT session_file, max(session_id), max(project_label), sum(cost_total), \
             coalesce(sum(credits),0), count(*) FROM messages",
        )
    };
    let tail = if from_rollup {
        format!(" ORDER BY cost_total DESC LIMIT {TOP_SESSIONS}")
    } else {
        format!(" GROUP BY session_file ORDER BY sum(cost_total) DESC LIMIT {TOP_SESSIONS}")
    };
    let sql = format!("{body}{}{tail}", w.sql());
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(w.params()), |r| {
        let session_file: String = r.get(0)?;
        let session_id: String = r.get(1)?;
        Ok(TopSession {
            label: short_label(&session_id, &session_file),
            session_id,
            project: r.get(2)?,
            usd: r.get(3)?,
            credits: r.get(4)?,
            calls: r.get(5)?,
            session_file,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[derive(Debug, Clone, Deserialize)]
pub struct Sort {
    pub key: String,
    pub dir: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Page {
    pub index: i64,
    pub size: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallRow {
    pub ts: i64,
    pub session_id: String,
    pub model: String,
    pub reasoning: String,
    pub project: String,
    pub agent_type: String,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub total_tokens: i64,
    pub usd: f64,
    pub credits: Option<f64>,
    pub duration_ms: Option<i64>,
    pub ttft_ms: Option<i64>,
    pub stop_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CallsPage {
    pub rows: Vec<CallRow>,
    pub total: i64,
}

/// Maps a renderer sort key to its column; anything else is `invalid-argument`.
fn sort_column(key: &str) -> QueryResult<&'static str> {
    Ok(match key {
        "ts" => "ts",
        "model" => "model",
        "project" => "project_label",
        "tokens" => "total_tokens",
        "usd" => "cost_total",
        "credits" => "credits",
        "input" => "input",
        "output" => "output",
        "cacheRead" => "cache_read",
        "duration" => "duration_ms",
        "ttft" => "ttft_ms",
        other => {
            return Err(QueryError::InvalidArgument(format!(
                "unknown sort key {other:?}"
            )))
        }
    })
}

pub fn calls(
    conn: &Connection,
    f: &Filters,
    sort: &Sort,
    page: Page,
    ctx: &QueryCtx,
) -> QueryResult<CallsPage> {
    let column = sort_column(&sort.key)?;
    let dir = match sort.dir.as_str() {
        "asc" => "ASC",
        "desc" => "DESC",
        other => {
            return Err(QueryError::InvalidArgument(format!(
                "unknown sort direction {other:?}"
            )))
        }
    };
    if page.index < 0 || page.size < 1 || page.size > MAX_PAGE_SIZE {
        return Err(QueryError::InvalidArgument(format!(
            "page size must be 1 to {MAX_PAGE_SIZE} and index at least 0"
        )));
    }
    let offset = page
        .index
        .checked_mul(page.size)
        .ok_or_else(|| QueryError::InvalidArgument("page index too large".into()))?;

    let mut w = f.build(&MESSAGES, ctx)?;
    let total: i64 = conn.query_row(
        &format!("SELECT count(*) FROM messages{}", w.sql()),
        rusqlite::params_from_iter(w.params()),
        |r| r.get(0),
    )?;
    let limit = w.bind(Value::Integer(page.size));
    let skip = w.bind(Value::Integer(offset));
    let sql = format!(
        "SELECT ts, session_id, model, reasoning, project_label, agent_type, input, output, cache_read, \
         cache_write, total_tokens, cost_total, credits, duration_ms, ttft_ms, stop_reason \
         FROM messages{} ORDER BY {column} {dir}, ts DESC, entry_id LIMIT {limit} OFFSET {skip}",
        w.sql()
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(w.params()), |r| {
            Ok(CallRow {
                ts: r.get(0)?,
                session_id: r.get(1)?,
                model: r.get(2)?,
                reasoning: r.get(3)?,
                project: r.get(4)?,
                agent_type: r.get(5)?,
                input: r.get(6)?,
                output: r.get(7)?,
                cache_read: r.get(8)?,
                cache_write: r.get(9)?,
                total_tokens: r.get(10)?,
                usd: r.get(11)?,
                credits: r.get(12)?,
                duration_ms: r.get(13)?,
                ttft_ms: r.get(14)?,
                stop_reason: r.get(15)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(CallsPage { rows, total })
}
