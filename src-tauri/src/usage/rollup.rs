// Spec 060 (S1-08): every write to the fact tables and the three rollups. A row that is new
// (INSERT OR IGNORE changed one row) adds its delta to the rollups in the same transaction the
// caller holds, so re-reading a file adds nothing (FR-005). Functions take the open transaction as
// `&Connection`. No prompt prose is accepted anywhere here: counts, ids, labels and sizes only.

use rusqlite::{params, Connection};

use super::timeutil::hour_start;

/// One assistant message or `model_usage` entry. `reasoning`, `model` and `project_label` are
/// `''` when unknown.
#[derive(Debug, Clone, Default)]
pub struct MessageRow {
    pub entry_id: String,
    pub ts: i64,
    pub session_id: String,
    pub provider: String,
    pub model: String,
    pub reasoning: String,
    pub agent_type: String,
    pub purpose: Option<String>,
    pub project_label: String,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub total_tokens: i64,
    pub cost_total: f64,
    pub cost_input: f64,
    pub cost_output: f64,
    pub cost_cache_read: f64,
    pub cost_cache_write: f64,
    pub credits: Option<f64>,
    pub premium_requests: f64,
    pub duration_ms: Option<i64>,
    pub ttft_ms: Option<i64>,
    pub stop_reason: Option<String>,
}

/// One assistant `toolCall` block, labelled from its issuing message.
#[derive(Debug, Clone)]
pub struct ToolCallRow<'a> {
    pub tool_call_id: &'a str,
    pub entry_id: &'a str,
    pub ts: i64,
    pub tool: &'a str,
    pub cost_share: f64,
    pub project_label: &'a str,
    pub model: &'a str,
    pub reasoning: &'a str,
    pub agent_type: &'a str,
}

/// A real user message's counts; the text itself is never passed in.
#[derive(Debug, Clone)]
pub struct UserMessageRow<'a> {
    pub entry_id: &'a str,
    pub ts: i64,
    pub chars: i64,
    pub yelling: i64,
    pub profanity: i64,
    pub blame: i64,
    pub project_label: &'a str,
}

const INSERT_MESSAGE: &str = "INSERT OR IGNORE INTO messages (session_file, entry_id, ts, session_id, provider, model, \
reasoning, agent_type, purpose, project_label, input, output, cache_read, cache_write, total_tokens, \
cost_total, cost_input, cost_output, cost_cache_read, cost_cache_write, credits, premium_requests, \
duration_ms, ttft_ms, stop_reason) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25)";

const UPSERT_MESSAGE_ROLLUP: &str = "INSERT INTO message_rollup (hour, project_label, model, reasoning, agent_type, calls, input, \
output, cache_read, cache_write, total_tokens, cost_total, cost_input, cost_output, cost_cache_read, \
cost_cache_write, credits) VALUES (?1,?2,?3,?4,?5,1,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16) \
ON CONFLICT(hour, project_label, model, reasoning, agent_type) DO UPDATE SET \
calls = calls + 1, input = input + excluded.input, output = output + excluded.output, \
cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write, \
total_tokens = total_tokens + excluded.total_tokens, cost_total = cost_total + excluded.cost_total, \
cost_input = cost_input + excluded.cost_input, cost_output = cost_output + excluded.cost_output, \
cost_cache_read = cost_cache_read + excluded.cost_cache_read, \
cost_cache_write = cost_cache_write + excluded.cost_cache_write, credits = credits + excluded.credits";

const UPSERT_SESSION_ROLLUP: &str = "INSERT INTO session_rollup (session_file, session_id, first_ts, last_ts, calls, cost_total, credits, \
project_label) VALUES (?1, ?2, ?3, ?3, 1, ?4, ?5, ?6) ON CONFLICT(session_file) DO UPDATE SET \
first_ts = MIN(first_ts, excluded.first_ts), last_ts = MAX(last_ts, excluded.last_ts), \
calls = calls + 1, cost_total = cost_total + excluded.cost_total, credits = credits + excluded.credits, \
project_label = excluded.project_label";

const UPSERT_TOOL_ROLLUP: &str = "INSERT INTO tool_rollup (hour, project_label, tool, agent_type, calls, errors, result_chars, cost_share) \
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(hour, project_label, tool, agent_type) DO UPDATE SET \
calls = calls + excluded.calls, errors = errors + excluded.errors, \
result_chars = result_chars + excluded.result_chars, cost_share = cost_share + excluded.cost_share";

/// Inserts a message and, only when it was new, adds it to `message_rollup` and `session_rollup`.
/// Returns whether it was new.
pub fn record_message(
    conn: &Connection,
    session_file: &str,
    m: &MessageRow,
) -> rusqlite::Result<bool> {
    let inserted = conn.prepare_cached(INSERT_MESSAGE)?.execute(params![
        session_file,
        m.entry_id,
        m.ts,
        m.session_id,
        m.provider,
        m.model,
        m.reasoning,
        m.agent_type,
        m.purpose,
        m.project_label,
        m.input,
        m.output,
        m.cache_read,
        m.cache_write,
        m.total_tokens,
        m.cost_total,
        m.cost_input,
        m.cost_output,
        m.cost_cache_read,
        m.cost_cache_write,
        m.credits,
        m.premium_requests,
        m.duration_ms,
        m.ttft_ms,
        m.stop_reason,
    ])? == 1;
    if !inserted {
        return Ok(false);
    }
    let credits = m.credits.unwrap_or(0.0);
    conn.prepare_cached(UPSERT_MESSAGE_ROLLUP)?
        .execute(params![
            hour_start(m.ts),
            m.project_label,
            m.model,
            m.reasoning,
            m.agent_type,
            m.input,
            m.output,
            m.cache_read,
            m.cache_write,
            m.total_tokens,
            m.cost_total,
            m.cost_input,
            m.cost_output,
            m.cost_cache_read,
            m.cost_cache_write,
            credits,
        ])?;
    conn.prepare_cached(UPSERT_SESSION_ROLLUP)?
        .execute(params![
            session_file,
            m.session_id,
            m.ts,
            m.cost_total,
            credits,
            m.project_label,
        ])?;
    Ok(true)
}

/// Inserts a tool call (result unknown yet) and, only when new, adds its call and cost share to
/// `tool_rollup`. Returns whether it was new.
pub fn record_tool_call(
    conn: &Connection,
    session_file: &str,
    t: &ToolCallRow,
) -> rusqlite::Result<bool> {
    let inserted = conn
        .prepare_cached(
            "INSERT OR IGNORE INTO tool_calls (session_file, tool_call_id, ts, entry_id, tool, is_error, \
             result_chars, cost_share, project_label, model, reasoning, agent_type) \
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, 0, ?6, ?7, ?8, ?9, ?10)",
        )?
        .execute(params![
            session_file,
            t.tool_call_id,
            t.ts,
            t.entry_id,
            t.tool,
            t.cost_share,
            t.project_label,
            t.model,
            t.reasoning,
            t.agent_type,
        ])?
        == 1;
    if inserted {
        conn.prepare_cached(UPSERT_TOOL_ROLLUP)?.execute(params![
            hour_start(t.ts),
            t.project_label,
            t.tool,
            t.agent_type,
            1i64,
            0i64,
            0i64,
            t.cost_share,
        ])?;
    }
    Ok(inserted)
}

/// Joins a `toolResult` to its call (the call may have landed in an earlier pass). Only the first
/// result for a call counts; its error flag and size are added to `tool_rollup` as a delta.
/// Returns whether a call was updated.
pub fn record_tool_result(
    conn: &Connection,
    session_file: &str,
    tool_call_id: &str,
    is_error: bool,
    result_chars: i64,
) -> rusqlite::Result<bool> {
    let updated =
        conn.prepare_cached(
            "UPDATE tool_calls SET is_error = ?3, result_chars = ?4 \
             WHERE session_file = ?1 AND tool_call_id = ?2 AND is_error IS NULL",
        )?
        .execute(params![
            session_file,
            tool_call_id,
            i64::from(is_error),
            result_chars
        ])? == 1;
    if !updated {
        return Ok(false);
    }
    let (ts, label, tool, agent_type): (i64, String, String, String) = conn
        .prepare_cached(
            "SELECT ts, project_label, tool, agent_type FROM tool_calls \
             WHERE session_file = ?1 AND tool_call_id = ?2",
        )?
        .query_row(params![session_file, tool_call_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?;
    conn.prepare_cached(UPSERT_TOOL_ROLLUP)?.execute(params![
        hour_start(ts),
        label,
        tool,
        agent_type,
        0i64,
        i64::from(is_error),
        result_chars,
        0.0f64,
    ])?;
    Ok(true)
}

pub fn record_user_message(
    conn: &Connection,
    session_file: &str,
    u: &UserMessageRow,
) -> rusqlite::Result<bool> {
    Ok(conn
        .prepare_cached(
            "INSERT OR IGNORE INTO user_messages (session_file, entry_id, ts, chars, yelling, profanity, \
             blame, project_label) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?
        .execute(params![
            session_file,
            u.entry_id,
            u.ts,
            u.chars,
            u.yelling,
            u.profanity,
            u.blame,
            u.project_label
        ])?
        == 1)
}

const ROLLUP_MESSAGES_OF_FILE: &str = "INSERT INTO message_rollup (hour, project_label, model, reasoning, agent_type, calls, input, \
output, cache_read, cache_write, total_tokens, cost_total, cost_input, cost_output, cost_cache_read, \
cost_cache_write, credits) \
SELECT ts - ts % 3600000, ?1, model, reasoning, agent_type, ?2 * count(*), ?2 * sum(input), ?2 * sum(output), \
?2 * sum(cache_read), ?2 * sum(cache_write), ?2 * sum(total_tokens), ?2 * sum(cost_total), \
?2 * sum(cost_input), ?2 * sum(cost_output), ?2 * sum(cost_cache_read), ?2 * sum(cost_cache_write), \
?2 * sum(coalesce(credits, 0)) FROM messages WHERE session_file = ?3 \
GROUP BY ts - ts % 3600000, model, reasoning, agent_type \
ON CONFLICT(hour, project_label, model, reasoning, agent_type) DO UPDATE SET \
calls = calls + excluded.calls, input = input + excluded.input, output = output + excluded.output, \
cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write, \
total_tokens = total_tokens + excluded.total_tokens, cost_total = cost_total + excluded.cost_total, \
cost_input = cost_input + excluded.cost_input, cost_output = cost_output + excluded.cost_output, \
cost_cache_read = cost_cache_read + excluded.cost_cache_read, \
cost_cache_write = cost_cache_write + excluded.cost_cache_write, credits = credits + excluded.credits";

const ROLLUP_TOOLS_OF_FILE: &str = "INSERT INTO tool_rollup (hour, project_label, tool, agent_type, calls, errors, result_chars, cost_share) \
SELECT ts - ts % 3600000, ?1, tool, agent_type, ?2 * count(*), ?2 * sum(coalesce(is_error, 0)), \
?2 * sum(result_chars), ?2 * sum(cost_share) FROM tool_calls WHERE session_file = ?3 \
GROUP BY ts - ts % 3600000, tool, agent_type \
ON CONFLICT(hour, project_label, tool, agent_type) DO UPDATE SET \
calls = calls + excluded.calls, errors = errors + excluded.errors, \
result_chars = result_chars + excluded.result_chars, cost_share = cost_share + excluded.cost_share";

/// Moves one file's rows from the `old` label to the `new` label: subtracts its contribution from
/// the rollups under `old`, adds it under `new`, rewrites the row labels and drops emptied rollup
/// rows. Run inside a transaction (`usage.relabel`).
pub fn relabel_file(
    conn: &Connection,
    session_file: &str,
    old: &str,
    new: &str,
) -> rusqlite::Result<()> {
    if old == new {
        return Ok(());
    }
    for (label, sign) in [(old, -1i64), (new, 1i64)] {
        conn.execute(ROLLUP_MESSAGES_OF_FILE, params![label, sign, session_file])?;
        conn.execute(ROLLUP_TOOLS_OF_FILE, params![label, sign, session_file])?;
    }
    for table in ["messages", "tool_calls", "user_messages"] {
        conn.execute(
            &format!("UPDATE {table} SET project_label = ?1 WHERE session_file = ?2"),
            params![new, session_file],
        )?;
    }
    conn.execute(
        "UPDATE session_rollup SET project_label = ?1 WHERE session_file = ?2",
        params![new, session_file],
    )?;
    conn.execute(
        "DELETE FROM message_rollup WHERE project_label = ?1 AND calls <= 0",
        [old],
    )?;
    conn.execute(
        "DELETE FROM tool_rollup WHERE project_label = ?1 AND calls <= 0 AND errors <= 0",
        [old],
    )?;
    Ok(())
}
