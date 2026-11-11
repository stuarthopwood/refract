// Every write to the fact tables and the three rollups. A new row adds its delta to the rollups in the
// caller's transaction, so re-reading a file adds nothing. No prompt text is accepted: counts only.

use rusqlite::{params, Connection};

use super::timeutil::hour_start;

/// One assistant message or `model_usage` entry; unknown labels are `''`.
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
    pub cost_usd: f64,
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

const UPSERT_TOOL_ROLLUP: &str = "INSERT INTO tool_rollup (hour, project_label, tool, agent_type, calls, errors, result_chars, cost_usd) \
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(hour, project_label, tool, agent_type) DO UPDATE SET \
calls = calls + excluded.calls, errors = errors + excluded.errors, \
result_chars = result_chars + excluded.result_chars, cost_usd = cost_usd + excluded.cost_usd";

/// Inserts a message; adds it to the rollups only when new. Returns whether it was new.
pub fn record_message(
    conn: &Connection,
    session_file: &str,
    m: &MessageRow,
) -> rusqlite::Result<bool> {
    let inserted = conn.prepare(INSERT_MESSAGE)?.execute(params![
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
    conn.prepare(UPSERT_MESSAGE_ROLLUP)?.execute(params![
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
    conn.prepare(UPSERT_SESSION_ROLLUP)?.execute(params![
        session_file,
        m.session_id,
        m.ts,
        m.cost_total,
        credits,
        m.project_label,
    ])?;
    Ok(true)
}

/// Inserts a tool call; adds it to `tool_rollup` only when new. Returns whether it was new.
pub fn record_tool_call(
    conn: &Connection,
    session_file: &str,
    t: &ToolCallRow,
) -> rusqlite::Result<bool> {
    let inserted = conn
        .prepare(
            "INSERT OR IGNORE INTO tool_calls (session_file, tool_call_id, ts, entry_id, tool, is_error, \
             result_chars, cost_usd, project_label, model, reasoning, agent_type) \
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, 0, ?6, ?7, ?8, ?9, ?10)",
        )?
        .execute(params![
            session_file,
            t.tool_call_id,
            t.ts,
            t.entry_id,
            t.tool,
            t.cost_usd,
            t.project_label,
            t.model,
            t.reasoning,
            t.agent_type,
        ])?
        == 1;
    if inserted {
        conn.prepare(UPSERT_TOOL_ROLLUP)?.execute(params![
            hour_start(t.ts),
            t.project_label,
            t.tool,
            t.agent_type,
            1i64,
            0i64,
            0i64,
            t.cost_usd,
        ])?;
    }
    Ok(inserted)
}

/// Joins a `toolResult` to its call; only the first result counts. Returns whether it updated.
pub fn record_tool_result(
    conn: &Connection,
    session_file: &str,
    tool_call_id: &str,
    is_error: bool,
    result_chars: i64,
) -> rusqlite::Result<bool> {
    let updated =
        conn.prepare(
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
        .prepare(
            "SELECT ts, project_label, tool, agent_type FROM tool_calls \
             WHERE session_file = ?1 AND tool_call_id = ?2",
        )?
        .query_row(params![session_file, tool_call_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?;
    conn.prepare(UPSERT_TOOL_ROLLUP)?.execute(params![
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
        .prepare(
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

/// Adds (`?2` = 1) or subtracts (`?2` = -1) one file's messages that are not yet labelled `?1`,
/// under `label`: `?1` for the new label, `project_label` for each row's own stored label.
fn rollup_messages_of_file(label: &str) -> String {
    format!(
        "INSERT INTO message_rollup (hour, project_label, model, reasoning, agent_type, calls, input, \
output, cache_read, cache_write, total_tokens, cost_total, cost_input, cost_output, cost_cache_read, \
cost_cache_write, credits) \
SELECT ts - ts % 3600000, {label}, model, reasoning, agent_type, ?2 * count(*), ?2 * sum(input), ?2 * sum(output), \
?2 * sum(cache_read), ?2 * sum(cache_write), ?2 * sum(total_tokens), ?2 * sum(cost_total), \
?2 * sum(cost_input), ?2 * sum(cost_output), ?2 * sum(cost_cache_read), ?2 * sum(cost_cache_write), \
?2 * sum(coalesce(credits, 0)) FROM messages WHERE session_file = ?3 AND project_label <> ?1 \
GROUP BY ts - ts % 3600000, project_label, model, reasoning, agent_type {ROLLUP_MESSAGES_UPSERT}"
    )
}

const ROLLUP_MESSAGES_UPSERT: &str = "\
ON CONFLICT(hour, project_label, model, reasoning, agent_type) DO UPDATE SET \
calls = calls + excluded.calls, input = input + excluded.input, output = output + excluded.output, \
cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write, \
total_tokens = total_tokens + excluded.total_tokens, cost_total = cost_total + excluded.cost_total, \
cost_input = cost_input + excluded.cost_input, cost_output = cost_output + excluded.cost_output, \
cost_cache_read = cost_cache_read + excluded.cost_cache_read, \
cost_cache_write = cost_cache_write + excluded.cost_cache_write, credits = credits + excluded.credits";

fn rollup_tools_of_file(label: &str) -> String {
    format!(
        "INSERT INTO tool_rollup (hour, project_label, tool, agent_type, calls, errors, result_chars, cost_usd) \
SELECT ts - ts % 3600000, {label}, tool, agent_type, ?2 * count(*), ?2 * sum(coalesce(is_error, 0)), \
?2 * sum(result_chars), ?2 * sum(cost_usd) FROM tool_calls WHERE session_file = ?3 AND project_label <> ?1 \
GROUP BY ts - ts % 3600000, project_label, tool, agent_type {ROLLUP_TOOLS_UPSERT}"
    )
}

const ROLLUP_TOOLS_UPSERT: &str = "\
ON CONFLICT(hour, project_label, tool, agent_type) DO UPDATE SET \
calls = calls + excluded.calls, errors = errors + excluded.errors, \
result_chars = result_chars + excluded.result_chars, cost_usd = cost_usd + excluded.cost_usd";

/// Moves one file's rows to `new`, subtracting each row from its own stored label's rollup first.
/// Drops emptied rollup rows; runs inside a transaction.
pub fn relabel_file(conn: &Connection, session_file: &str, new: &str) -> rusqlite::Result<()> {
    for (label, sign) in [("project_label", -1i64), ("?1", 1i64)] {
        conn.execute(
            &rollup_messages_of_file(label),
            params![new, sign, session_file],
        )?;
        conn.execute(
            &rollup_tools_of_file(label),
            params![new, sign, session_file],
        )?;
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
    conn.execute("DELETE FROM message_rollup WHERE calls <= 0", [])?;
    conn.execute(
        "DELETE FROM tool_rollup WHERE calls <= 0 AND errors <= 0",
        [],
    )?;
    conn.execute(
        "UPDATE message_rollup SET cost_total = max(cost_total, 0.0), cost_input = max(cost_input, 0.0), \
         cost_output = max(cost_output, 0.0), cost_cache_read = max(cost_cache_read, 0.0), \
         cost_cache_write = max(cost_cache_write, 0.0), credits = max(credits, 0.0) \
         WHERE cost_total < 0 OR cost_input < 0 OR cost_output < 0 OR cost_cache_read < 0 \
         OR cost_cache_write < 0 OR credits < 0",
        [],
    )?;
    conn.execute(
        "UPDATE tool_rollup SET cost_usd = max(cost_usd, 0.0) WHERE cost_usd < 0",
        [],
    )?;
    Ok(())
}

/// Removes every message of one file and subtracts it from the rollups, so a source whose rows are
/// replaced wholesale (Copilot CLI's per-session total) can be rewritten. Runs inside a transaction.
pub fn forget_file_messages(conn: &Connection, session_file: &str) -> rusqlite::Result<()> {
    // A NUL label differs from every stored label, so the subtracting statement selects all rows.
    conn.execute(
        &rollup_messages_of_file("project_label"),
        params!["\0", -1i64, session_file],
    )?;
    conn.execute(
        "DELETE FROM messages WHERE session_file = ?1",
        [session_file],
    )?;
    conn.execute(
        "DELETE FROM session_rollup WHERE session_file = ?1",
        [session_file],
    )?;
    conn.execute("DELETE FROM message_rollup WHERE calls <= 0", [])?;
    conn.execute(
        "UPDATE message_rollup SET cost_total = max(cost_total, 0.0), cost_input = max(cost_input, 0.0), \
         cost_output = max(cost_output, 0.0), cost_cache_read = max(cost_cache_read, 0.0), \
         cost_cache_write = max(cost_cache_write, 0.0), credits = max(credits, 0.0) \
         WHERE cost_total < 0 OR cost_input < 0 OR cost_output < 0 OR cost_cache_read < 0 \
         OR cost_cache_write < 0 OR credits < 0",
        [],
    )?;
    Ok(())
}
