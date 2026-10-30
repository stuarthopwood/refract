// Walks the OMP sessions folder (read-only, never following symlinks) for changed `*.jsonl` files.

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

/// `advisor` for an `__advisor` session file (a WATCHDOG.yml roster or the Advisor role),
/// `main` for any other top-level file, `subagent` for anything nested deeper.
pub fn agent_type_for(path: &Path, sessions_root: &Path) -> &'static str {
    if path
        .file_name()
        .is_some_and(|name| name.to_string_lossy().contains("__advisor"))
    {
        return "advisor";
    }
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
    conn.prepare("SELECT last_modified, file_len FROM file_offsets WHERE session_file = ?1")
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

/// Ingests every changed file under `root`. `stop()` is polled between files so shutdown is prompt.
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
