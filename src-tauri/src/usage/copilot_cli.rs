// GitHub Copilot CLI usage: `<root>/<session id>/events.jsonl`. Only the LAST `session.shutdown`
// event is read, because its `totalNanoAiu` is cumulative across `session.resume`. The session is
// stored as one row per model under fixed entry ids and replaced whenever the file changes.

use std::fs::{self, File};
use std::io::BufReader;
use std::path::Path;
use std::time::UNIX_EPOCH;

use rusqlite::{params, Connection};
use serde_json::Value;

use super::ingest::{read_line, text_of, LineRead};
use super::project_label::ProjectIndex;
use super::rollup::{forget_file_messages, record_message, MessageRow};
use super::scan::{unchanged, ScanReport, SessionFile};
use super::timeutil::parse_iso_ms;

/// Provider stored on every row, distinct from OMP's `github-copilot`.
pub const PROVIDER: &str = "copilot-cli";
const EVENTS_FILE: &str = "events.jsonl";
const NANO_PER_CREDIT: f64 = 1e9;
/// One AI credit is one US cent.
const USD_PER_CREDIT: f64 = 0.01;
/// Anything smaller than a nano-credit is float noise in `total - sum(models)`.
const REMAINDER_EPSILON_NANO: f64 = 1.0;
// JSON-escaped quotes inside message text never match these, so a byte search cannot false-positive.
const SHUTDOWN_MARK: &[u8] = br#""type":"session.shutdown""#;
const START_MARK: &[u8] = br#""type":"session.start""#;

struct Shutdown {
    ts: i64,
    total_nano: f64,
    models: Vec<(String, f64)>,
    current_model: String,
}

struct Summary {
    session_id: String,
    cwd: Option<String>,
    shutdown: Option<Shutdown>,
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn nano_of(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n > 0.0)
}

fn parse_shutdown(event: &Value) -> Option<Shutdown> {
    if text_of(event.get("type")) != Some("session.shutdown") {
        return None;
    }
    let data = event.get("data")?;
    let ts = text_of(event.get("timestamp")).and_then(parse_iso_ms)?;
    let total_nano = data.get("totalNanoAiu").and_then(Value::as_f64)?;
    if !total_nano.is_finite() || total_nano < 0.0 {
        return None;
    }
    let mut models: Vec<(String, f64)> = data
        .get("modelMetrics")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(name, m)| Some((name.clone(), nano_of(m.get("totalNanoAiu"))?)))
        .collect();
    models.sort_by(|a, b| a.0.cmp(&b.0));
    Some(Shutdown {
        ts,
        total_nano,
        models,
        current_model: text_of(data.get("currentModel"))
            .unwrap_or_default()
            .to_string(),
    })
}

/// Streams the file once, parsing only the start line and shutdown lines.
fn read_summary(path: &Path, dir_name: &str) -> Result<Summary, String> {
    let file = File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut summary = Summary {
        session_id: dir_name.to_string(),
        cwd: None,
        shutdown: None,
    };
    let mut started = false;
    let mut buf = Vec::new();
    loop {
        match read_line(&mut reader, &mut buf)
            .map_err(|e| format!("read {}: {e}", path.display()))?
        {
            LineRead::Eof | LineRead::Partial => break,
            LineRead::Oversize(_) => {}
            LineRead::Line(_) => {
                if !started && contains(&buf, START_MARK) {
                    started = true;
                    if let Ok(event) = serde_json::from_slice::<Value>(&buf) {
                        let data = event.get("data");
                        if let Some(id) = text_of(data.and_then(|d| d.get("sessionId"))) {
                            summary.session_id = id.to_string();
                        }
                        summary.cwd = text_of(
                            data.and_then(|d| d.get("context"))
                                .and_then(|c| c.get("cwd")),
                        )
                        .map(str::to_string);
                    }
                } else if contains(&buf, SHUTDOWN_MARK) {
                    if let Some(shutdown) = serde_json::from_slice::<Value>(&buf)
                        .ok()
                        .as_ref()
                        .and_then(parse_shutdown)
                    {
                        summary.shutdown = Some(shutdown);
                    }
                }
            }
        }
    }
    Ok(summary)
}

fn credit_row(
    entry: &str,
    model: &str,
    nano: f64,
    shutdown: &Shutdown,
    session_id: &str,
    label: &str,
) -> MessageRow {
    let credits = nano / NANO_PER_CREDIT;
    MessageRow {
        entry_id: format!("shutdown:{entry}"),
        ts: shutdown.ts,
        session_id: session_id.to_string(),
        provider: PROVIDER.to_string(),
        model: model.to_string(),
        agent_type: "main".to_string(),
        project_label: label.to_string(),
        cost_total: credits * USD_PER_CREDIT,
        credits: Some(credits),
        ..MessageRow::default()
    }
}

/// One row per model plus a remainder row, so the rows always sum to `totalNanoAiu`.
fn rows(shutdown: &Shutdown, session_id: &str, label: &str) -> Vec<MessageRow> {
    let mut out: Vec<MessageRow> = shutdown
        .models
        .iter()
        .map(|(model, nano)| credit_row(model, model, *nano, shutdown, session_id, label))
        .collect();
    let remainder = shutdown.total_nano - shutdown.models.iter().map(|(_, n)| n).sum::<f64>();
    if remainder >= REMAINDER_EPSILON_NANO {
        out.push(credit_row(
            "remainder",
            &shutdown.current_model,
            remainder,
            shutdown,
            session_id,
            label,
        ));
    }
    out
}

/// Ingests one `events.jsonl`; returns the rows written. A file with no shutdown event yet (a live
/// session) only records its size, so it is read again once it grows.
pub fn ingest_events_file(
    conn: &mut Connection,
    path: &Path,
    root: &Path,
    projects: &ProjectIndex,
) -> Result<u64, String> {
    let key = path.to_string_lossy().into_owned();
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Ok(0);
    }
    let meta = fs::metadata(path).map_err(|e| format!("stat {key}: {e}"))?;
    let len = meta.len() as i64;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64);
    let dir_name = path
        .parent()
        .and_then(Path::file_name)
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let summary = read_summary(path, &dir_name)?;
    let label = projects.label(summary.cwd.as_deref(), path, root);

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut written = 0u64;
    if let Some(shutdown) = &summary.shutdown {
        forget_file_messages(&tx, &key).map_err(|e| e.to_string())?;
        for row in rows(shutdown, &summary.session_id, &label) {
            if record_message(&tx, &key, &row).map_err(|e| e.to_string())? {
                written += 1;
            }
        }
    }
    tx.execute(
        "INSERT INTO file_offsets (session_file, offset, last_modified, file_len, session_id, cwd, \
         agent_type, project_label) VALUES (?1,?2,?3,?2,?4,?5,'main',?6) \
         ON CONFLICT(session_file) DO UPDATE SET offset = excluded.offset, \
         last_modified = excluded.last_modified, file_len = excluded.file_len, \
         session_id = excluded.session_id, cwd = excluded.cwd, project_label = excluded.project_label",
        params![key, len, mtime_ms, summary.session_id, summary.cwd, label],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(written)
}

/// Every `<root>/<id>/events.jsonl`, never following symlinks. A missing root yields nothing.
fn list_event_files(root: &Path) -> Vec<SessionFile> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| {
            let path = e.path().join(EVENTS_FILE);
            let meta = fs::symlink_metadata(&path).ok().filter(|m| m.is_file())?;
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as i64);
            Some(SessionFile {
                path,
                len: meta.len() as i64,
                mtime_ms,
            })
        })
        .collect()
}

/// Ingests every changed `events.jsonl` under `root`.
pub fn scan(
    conn: &mut Connection,
    root: &Path,
    projects: &ProjectIndex,
    progress: &mut dyn FnMut(usize, usize),
) -> ScanReport {
    let files = list_event_files(root);
    let mut report = ScanReport {
        seen: files.len(),
        ..ScanReport::default()
    };
    progress(report.seen, 0);
    for file in &files {
        if !unchanged(conn, file) {
            match ingest_events_file(conn, &file.path, root, projects) {
                Ok(n) => report.new_messages += n,
                Err(e) => log::warn!("copilot usage ingest failed: {e}"),
            }
        }
        report.done += 1;
        progress(report.seen, report.done);
    }
    report
}
