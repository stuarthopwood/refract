// Incremental ingest of one OMP session `.jsonl`. The stored offset only stops on a line boundary,
// so a half-written line is re-read next pass. Prompt text is scored and dropped.

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::credits::credits_for;
use super::fingerprint::Window;
use super::frustration;
use super::project_label::ProjectIndex;
use super::rollup::{
    record_message, record_tool_call, record_tool_result, record_user_message, MessageRow,
    ToolCallRow, UserMessageRow,
};
use super::timeutil::parse_iso_ms;

/// Lines longer than this are skipped unread.
pub(super) const MAX_LINE_BYTES: u64 = 8 * 1024 * 1024;
/// One pass stops after this many bytes; the caller re-queues the file when `more` is set.
const MAX_PASS_BYTES: u64 = 64 * 1024 * 1024;
/// Only this many leading characters of a user message are scored.
const SCORE_CHARS: usize = 20_000;

#[derive(Debug, Clone, Copy, Default)]
pub struct IngestOutcome {
    /// New assistant messages stored by this pass.
    pub new_messages: u64,
    /// The pass hit its byte cap before the end of the file.
    pub more: bool,
}

/// Per-file parse state, persisted in `file_offsets` so a resume starts mid-file correctly.
#[derive(Debug, Default)]
struct FileState {
    offset: i64,
    session_id: String,
    cwd: Option<String>,
    project_label: String,
    cur_model: String,
    cur_reasoning: String,
    /// Fingerprint of the first bytes of the file (never past the consumed offset).
    head: Window,
    /// Fingerprint of the bytes just before `offset`; unknown (len 0) in rows saved before it existed.
    tail: Window,
}

pub(super) enum LineRead {
    Eof,
    /// No trailing newline yet: the writer has not finished the line.
    Partial,
    Line(u64),
    Oversize(u64),
}

pub(super) fn read_line<R: BufRead>(r: &mut R, buf: &mut Vec<u8>) -> std::io::Result<LineRead> {
    buf.clear();
    let n = r.by_ref().take(MAX_LINE_BYTES + 1).read_until(b'\n', buf)? as u64;
    if n == 0 {
        return Ok(LineRead::Eof);
    }
    if buf.last() == Some(&b'\n') {
        return Ok(LineRead::Line(n));
    }
    if n <= MAX_LINE_BYTES {
        return Ok(LineRead::Partial);
    }
    let mut consumed = n;
    let mut scratch = Vec::new();
    loop {
        scratch.clear();
        let m = r.by_ref().take(64 * 1024).read_until(b'\n', &mut scratch)? as u64;
        if m == 0 {
            return Ok(LineRead::Partial);
        }
        consumed += m;
        if scratch.last() == Some(&b'\n') {
            return Ok(LineRead::Oversize(consumed));
        }
    }
}

fn load_state(conn: &Connection, key: &str) -> rusqlite::Result<FileState> {
    Ok(conn
        .prepare(
            "SELECT offset, session_id, cwd, project_label, cur_model, cur_reasoning, \
             head_len, head_hash, tail_len, tail_hash FROM file_offsets WHERE session_file = ?1",
        )?
        .query_row([key], |r| {
            Ok(FileState {
                offset: r.get(0)?,
                session_id: r.get(1)?,
                cwd: r.get(2)?,
                project_label: r.get(3)?,
                cur_model: r.get(4)?,
                cur_reasoning: r.get(5)?,
                head: Window {
                    len: r.get(6)?,
                    hash: r.get(7)?,
                },
                tail: Window {
                    len: r.get(8)?,
                    hash: r.get(9)?,
                },
            })
        })
        .optional()?
        .unwrap_or_default())
}

fn save_state(
    conn: &Connection,
    key: &str,
    state: &FileState,
    agent_type: &str,
    len: i64,
    mtime_ms: i64,
) -> rusqlite::Result<()> {
    conn.prepare(
        "INSERT INTO file_offsets (session_file, offset, last_modified, file_len, session_id, cwd, \
         agent_type, project_label, cur_model, cur_reasoning, head_len, head_hash, tail_len, \
         tail_hash) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14) \
         ON CONFLICT(session_file) DO UPDATE SET offset = excluded.offset, \
         last_modified = excluded.last_modified, file_len = excluded.file_len, \
         session_id = excluded.session_id, cwd = excluded.cwd, agent_type = excluded.agent_type, \
         project_label = excluded.project_label, cur_model = excluded.cur_model, \
         cur_reasoning = excluded.cur_reasoning, head_len = excluded.head_len, \
         head_hash = excluded.head_hash, tail_len = excluded.tail_len, \
         tail_hash = excluded.tail_hash",
    )?
    .execute(params![
        key,
        state.offset,
        mtime_ms,
        len,
        state.session_id,
        state.cwd,
        agent_type,
        state.project_label,
        state.cur_model,
        state.cur_reasoning,
        state.head.len,
        state.head.hash,
        state.tail.len,
        state.tail.hash,
    ])?;
    Ok(())
}

/// Integer JSON value (floats truncate).
fn opt_i64(v: Option<&Value>) -> Option<i64> {
    v.and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
}

fn num_i64(v: Option<&Value>) -> i64 {
    opt_i64(v).unwrap_or(0)
}

fn num_f64(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64).unwrap_or(0.0)
}

pub(super) fn text_of(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// Entry time in ms: the message's own epoch-ms stamp, else the entry's ISO stamp.
fn entry_ts(entry: &Value, message: Option<&Value>) -> i64 {
    message
        .and_then(|m| m.get("timestamp"))
        .and_then(Value::as_f64)
        .filter(|t| *t > 1e11)
        .map(|t| t as i64)
        .or_else(|| text_of(entry.get("timestamp")).and_then(parse_iso_ms))
        .unwrap_or(0)
}

/// Splits `provider/model`; a bare name has no provider.
fn split_model(full: &str) -> (&str, &str) {
    full.split_once('/').unwrap_or(("", full))
}

fn content_parts(message: &Value) -> impl Iterator<Item = &Value> {
    message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn text_parts(message: &Value) -> impl Iterator<Item = &str> {
    content_parts(message)
        .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|p| p.get("text").and_then(Value::as_str))
}

fn usage_row(
    entry_id: &str,
    ts: i64,
    holder: &Value,
    usage: &Value,
    state: &FileState,
    agent_type: &str,
) -> MessageRow {
    let (cur_provider, cur_model) = split_model(&state.cur_model);
    let provider = text_of(holder.get("provider")).unwrap_or(cur_provider);
    let model = text_of(holder.get("model")).unwrap_or(cur_model);
    let cost = usage.get("cost");
    let cost_total = num_f64(cost.and_then(|c| c.get("total")));
    MessageRow {
        entry_id: entry_id.to_string(),
        ts,
        session_id: state.session_id.clone(),
        provider: provider.to_string(),
        model: model.to_string(),
        reasoning: state.cur_reasoning.clone(),
        agent_type: agent_type.to_string(),
        purpose: text_of(holder.get("purpose")).map(str::to_string),
        project_label: state.project_label.clone(),
        input: num_i64(usage.get("input")),
        output: num_i64(usage.get("output")),
        cache_read: num_i64(usage.get("cacheRead")),
        cache_write: num_i64(usage.get("cacheWrite")),
        total_tokens: num_i64(usage.get("totalTokens")),
        cost_total,
        cost_input: num_f64(cost.and_then(|c| c.get("input"))),
        cost_output: num_f64(cost.and_then(|c| c.get("output"))),
        cost_cache_read: num_f64(cost.and_then(|c| c.get("cacheRead"))),
        cost_cache_write: num_f64(cost.and_then(|c| c.get("cacheWrite"))),
        credits: credits_for(provider, cost_total),
        premium_requests: num_f64(usage.get("premiumRequests")),
        duration_ms: opt_i64(holder.get("duration")),
        ttft_ms: opt_i64(holder.get("ttft")),
        stop_reason: text_of(holder.get("stopReason")).map(str::to_string),
    }
}

struct Pass<'a> {
    conn: &'a Connection,
    key: &'a str,
    agent_type: &'a str,
    root: &'a Path,
    path: &'a Path,
    projects: &'a ProjectIndex,
    state: FileState,
    new_messages: u64,
}

impl Pass<'_> {
    fn set_label(&mut self) {
        self.state.project_label =
            self.projects
                .label(self.state.cwd.as_deref(), self.path, self.root);
    }

    fn entry(&mut self, entry: &Value) -> rusqlite::Result<()> {
        match entry.get("type").and_then(Value::as_str) {
            Some("session") => {
                self.state.session_id = text_of(entry.get("id")).unwrap_or_default().to_string();
                self.state.cwd = text_of(entry.get("cwd")).map(str::to_string);
                self.set_label();
            }
            Some("model_change") => {
                if let Some(m) = text_of(entry.get("model")) {
                    self.state.cur_model = m.to_string();
                }
            }
            Some("thinking_level_change") => {
                if let Some(l) = text_of(entry.get("thinkingLevel")) {
                    self.state.cur_reasoning = l.to_string();
                }
            }
            Some("model_usage") => {
                if let (Some(id), Some(usage)) = (text_of(entry.get("id")), entry.get("usage")) {
                    let ts = entry_ts(entry, None);
                    if ts > 0 {
                        self.message(id, ts, entry, usage)?;
                    }
                }
            }
            Some("message") => {
                if let (Some(id), Some(message)) = (text_of(entry.get("id")), entry.get("message"))
                {
                    self.chat_message(id, entry, message)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn message(
        &mut self,
        id: &str,
        ts: i64,
        holder: &Value,
        usage: &Value,
    ) -> rusqlite::Result<bool> {
        if self.state.project_label.is_empty() {
            self.set_label();
        }
        let row = usage_row(id, ts, holder, usage, &self.state, self.agent_type);
        let fresh = record_message(self.conn, self.key, &row)?;
        if fresh {
            self.new_messages += 1;
        }
        Ok(fresh)
    }

    fn chat_message(&mut self, id: &str, entry: &Value, message: &Value) -> rusqlite::Result<()> {
        let ts = entry_ts(entry, Some(message));
        match message.get("role").and_then(Value::as_str) {
            Some("assistant") => {
                if ts <= 0 {
                    return Ok(());
                }
                if let Some(usage) = message.get("usage") {
                    self.message(id, ts, message, usage)?;
                }
                self.tool_calls(id, ts, message)?;
            }
            Some("toolResult") => {
                if let Some(call_id) = text_of(message.get("toolCallId")) {
                    let is_error = message
                        .get("isError")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let chars: usize = text_parts(message).map(|t| t.chars().count()).sum();
                    record_tool_result(self.conn, self.key, call_id, is_error, chars as i64)?;
                }
            }
            Some("user") => self.user_message(id, ts, message)?,
            _ => {}
        }
        Ok(())
    }

    fn tool_calls(&mut self, entry_id: &str, ts: i64, message: &Value) -> rusqlite::Result<()> {
        let calls: Vec<&Value> = content_parts(message)
            .filter(|p| p.get("type").and_then(Value::as_str) == Some("toolCall"))
            .collect();
        if calls.is_empty() {
            return Ok(());
        }
        if self.state.project_label.is_empty() {
            self.set_label();
        }
        let total = num_f64(
            message
                .get("usage")
                .and_then(|u| u.get("cost"))
                .and_then(|c| c.get("total")),
        );
        let share = total / calls.len() as f64;
        let (_, cur_model) = split_model(&self.state.cur_model);
        let model = text_of(message.get("model")).unwrap_or(cur_model);
        for call in calls {
            let (Some(call_id), Some(tool)) = (text_of(call.get("id")), text_of(call.get("name")))
            else {
                continue;
            };
            record_tool_call(
                self.conn,
                self.key,
                &ToolCallRow {
                    tool_call_id: call_id,
                    entry_id,
                    ts,
                    tool,
                    cost_usd: share,
                    project_label: &self.state.project_label,
                    model,
                    reasoning: &self.state.cur_reasoning,
                    agent_type: self.agent_type,
                },
            )?;
        }
        Ok(())
    }

    fn user_message(&mut self, id: &str, ts: i64, message: &Value) -> rusqlite::Result<()> {
        let synthetic = message.get("synthetic").and_then(Value::as_bool) == Some(true);
        let foreign = message
            .get("attribution")
            .and_then(Value::as_str)
            .is_some_and(|a| a != "user");
        if synthetic || foreign || ts <= 0 {
            return Ok(());
        }
        if self.state.project_label.is_empty() {
            self.set_label();
        }
        let mut chars = 0usize;
        let mut scored = String::new();
        for part in text_parts(message) {
            let n = part.chars().count();
            let room = SCORE_CHARS.saturating_sub(scored.chars().count());
            if room > 0 {
                scored.extend(part.chars().take(room));
            }
            chars += n;
        }
        let s = frustration::score(&scored);
        record_user_message(
            self.conn,
            self.key,
            &UserMessageRow {
                entry_id: id,
                ts,
                chars: chars as i64,
                yelling: s.yelling,
                profanity: s.profanity,
                blame: s.blame,
                project_label: &self.state.project_label,
            },
        )?;
        Ok(())
    }
}

/// Ingests the new complete lines of `path` in one transaction; a failed file keeps its old offset.
pub fn ingest_file(
    conn: &mut Connection,
    path: &Path,
    agent_type: &str,
    sessions_root: &Path,
    projects: &ProjectIndex,
) -> Result<IngestOutcome, String> {
    let key = path.to_string_lossy().into_owned();
    // The sessions walk never follows symlinks; a nudge must not either.
    if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Ok(IngestOutcome::default());
    }
    let mut file = File::open(path).map_err(|e| format!("open {key}: {e}"))?;
    let meta = file.metadata().map_err(|e| format!("stat {key}: {e}"))?;
    let len = meta.len();
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64);

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut state = load_state(&tx, &key).map_err(|e| e.to_string())?;
    // A shrunk file, a re-headed file, or one whose bytes before the saved offset changed was
    // rewritten: restart from byte 0. Re-read rows dedupe on (file, entry id).
    let offset = state.offset;
    let rewritten = offset as u64 > len
        || state
            .head
            .changed(&mut file, 0)
            .map_err(|e| format!("read {key}: {e}"))?
        || state
            .tail
            .changed(&mut file, offset - state.tail.len)
            .map_err(|e| format!("read {key}: {e}"))?;
    if rewritten {
        state = FileState::default();
    }
    let mut reader = BufReader::new(file);
    reader
        .seek(SeekFrom::Start(state.offset as u64))
        .map_err(|e| format!("seek {key}: {e}"))?;

    let mut pass = Pass {
        conn: &tx,
        key: &key,
        agent_type,
        root: sessions_root,
        path,
        projects,
        state,
        new_messages: 0,
    };
    let mut buf = Vec::new();
    let mut consumed = 0u64;
    let mut more = false;
    loop {
        if consumed >= MAX_PASS_BYTES {
            more = true;
            break;
        }
        match read_line(&mut reader, &mut buf).map_err(|e| format!("read {key}: {e}"))? {
            LineRead::Eof | LineRead::Partial => break,
            LineRead::Oversize(n) => consumed += n,
            LineRead::Line(n) => {
                consumed += n;
                if let Ok(entry) = serde_json::from_slice::<Value>(&buf) {
                    pass.entry(&entry).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    let mut state = pass.state;
    let new_messages = pass.new_messages;
    state.offset += consumed as i64;
    state.head = Window::head(reader.get_mut(), state.offset);
    state.tail = Window::tail(reader.get_mut(), state.offset);
    save_state(&tx, &key, &state, agent_type, len as i64, mtime_ms).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(IngestOutcome { new_messages, more })
}

#[cfg(test)]
#[path = "ingest.test.rs"]
mod tests;
