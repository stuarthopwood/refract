// Spec 060 (S1-09): the sessions-directory walk. Finds every `*.jsonl` under the OMP sessions
// root (never following symlinks), skips files whose size and mtime match what the last pass
// recorded, and ingests the rest newest first so the Usage view fills with recent data first.
// Read-only: nothing under the sessions directory is ever written.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rusqlite::{Connection, OptionalExtension};

use super::ingest::ingest_file;
use super::project_label::ProjectIndex;

const MAX_DEPTH: usize = 6;

#[derive(Debug, Clone)]
pub struct SessionFile {
    pub path: PathBuf,
    pub len: i64,
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ScanReport {
    pub seen: usize,
    pub done: usize,
    pub new_messages: u64,
}

/// `main` for `<root>/<folder>/<session>.jsonl`, `subagent` for anything nested deeper
/// (`<root>/<folder>/<session>/<agent>.jsonl`).
pub fn agent_type_for(path: &Path, sessions_root: &Path) -> &'static str {
    let depth = path
        .strip_prefix(sessions_root)
        .map_or(0, |rel| rel.components().count());
    if depth <= 2 {
        "main"
    } else {
        "subagent"
    }
}

/// Every `.jsonl` under `root`, newest first. A missing or unreadable root yields nothing.
pub fn list_session_files(root: &Path) -> Vec<SessionFile> {
    let mut found = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                if depth < MAX_DEPTH {
                    stack.push((path, depth + 1));
                }
            } else if kind.is_file() && path.extension().is_some_and(|e| e == "jsonl") {
                if let Ok(meta) = entry.metadata() {
                    let mtime_ms = meta
                        .modified()
                        .ok()
                        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                        .map_or(0, |d| d.as_millis() as i64);
                    found.push(SessionFile {
                        path,
                        len: meta.len() as i64,
                        mtime_ms,
                    });
                }
            }
        }
    }
    found.sort_by_key(|f| std::cmp::Reverse(f.mtime_ms));
    found
}

fn unchanged(conn: &Connection, file: &SessionFile) -> bool {
    conn.prepare_cached("SELECT last_modified, file_len FROM file_offsets WHERE session_file = ?1")
        .and_then(|mut s| {
            s.query_row([file.path.to_string_lossy().as_ref()], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            })
            .optional()
        })
        .ok()
        .flatten()
        .is_some_and(|(mtime, len)| mtime == file.mtime_ms && len == file.len)
}

/// Ingests every changed file under `root`. `progress(seen, done)` is called after each file;
/// `stop()` is polled between files so a shutdown does not wait for the whole backlog. A file that
/// fails is logged and skipped; the rest still run.
pub fn scan(
    conn: &mut Connection,
    root: &Path,
    projects: &ProjectIndex,
    progress: &mut dyn FnMut(usize, usize),
    stop: &dyn Fn() -> bool,
) -> ScanReport {
    let files = list_session_files(root);
    let mut report = ScanReport {
        seen: files.len(),
        ..ScanReport::default()
    };
    progress(report.seen, 0);
    for file in &files {
        if stop() {
            break;
        }
        if !unchanged(conn, file) {
            let agent = agent_type_for(&file.path, root);
            loop {
                match ingest_file(conn, &file.path, agent, root, projects) {
                    Ok(outcome) => {
                        report.new_messages += outcome.new_messages;
                        if !outcome.more {
                            break;
                        }
                    }
                    Err(e) => {
                        log::warn!("usage ingest failed: {e}");
                        break;
                    }
                }
            }
        }
        report.done += 1;
        progress(report.seen, report.done);
    }
    report
}
