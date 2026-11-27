// Failed tool calls grouped by category. Read from the per-call table: the rollups carry no category.

use rusqlite::Connection;
use serde::Serialize;

use super::queries::{Filters, QueryCtx, QueryResult, TOOL_CALLS};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorCategoryRow {
    /// An `ErrorCategory::as_str()` value; the renderer owns the display label.
    pub category: String,
    pub count: i64,
}

/// Every failed call in the filtered window, most frequent category first.
pub fn error_categories(
    conn: &Connection,
    f: &Filters,
    ctx: &QueryCtx,
) -> QueryResult<Vec<ErrorCategoryRow>> {
    let mut w = f.build(&TOOL_CALLS, ctx)?;
    w.require("is_error = 1");
    let sql = format!(
        "SELECT coalesce(error_category, 'unknown'), count(*) FROM tool_calls{} \
         GROUP BY 1 ORDER BY 2 DESC, 1",
        w.sql()
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(w.params()), |r| {
        Ok(ErrorCategoryRow {
            category: r.get(0)?,
            count: r.get(1)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[cfg(test)]
#[path = "queries_errors.test.rs"]
mod tests;
