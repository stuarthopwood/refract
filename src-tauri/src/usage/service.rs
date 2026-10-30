// Spec 060 (S1-10): the Usage ingest service. One lazily started `std::thread` owns the writer
// connection to `usage.db`; it runs a full scan on `start`, again every five minutes while
// started, and ingests a single file on `nudge`. Nothing here blocks the IPC thread or the tokio
// pool. The IPC layer wires `emit` to the `usage.progress` event and `projects` to the registry.

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use rusqlite::{params, Connection};
use serde::Serialize;

use super::project_label::ProjectIndex;
use super::{ingest, paths, rollup, scan, schema};

const SCAN_INTERVAL: Duration = Duration::from_secs(5 * 60);
const EMIT_INTERVAL: Duration = Duration::from_secs(1);

/// Snapshot behind `usage.status` and the `usage.progress` event.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatus {
    pub running: bool,
    pub sessions_seen: usize,
    pub sessions_done: usize,
    pub sessions_dir: String,
    pub found: bool,
}

/// Supplies the current Projects and Worktrees for Project labelling; called once per pass.
pub type ProjectsProvider = Arc<dyn Fn() -> ProjectIndex + Send + Sync>;
/// Receives each throttled status change (wired to the `usage.progress` event).
pub type StatusEmit = Arc<dyn Fn(&UsageStatus) + Send + Sync>;

enum Msg {
    Scan,
    /// The five-minute timer fired; unlike `Scan` it is not deduped through `scan_pending`.
    Rescan,
    Nudge(PathBuf),
    /// `stop()` ran: the worker drops its connection and sleeps until the next `start()`.
    Stop,
}

struct Inner {
    root: PathBuf,
    db_path: PathBuf,
    projects: ProjectsProvider,
    emit: StatusEmit,
    status: Mutex<UsageStatus>,
    last_error: Mutex<Option<String>>,
    started: AtomicBool,
    scan_pending: AtomicBool,
}

pub struct UsageService {
    inner: Arc<Inner>,
    tx: Mutex<Option<Sender<Msg>>>,
}

impl UsageService {
    pub fn new(emit: StatusEmit, projects: ProjectsProvider) -> Self {
        Self::with_paths(
            paths::sessions_dir(),
            paths::usage_db_path(),
            emit,
            projects,
        )
    }

    pub fn with_paths(
        root: PathBuf,
        db_path: PathBuf,
        emit: StatusEmit,
        projects: ProjectsProvider,
    ) -> Self {
        let status = UsageStatus {
            sessions_dir: root.to_string_lossy().into_owned(),
            found: root.is_dir(),
            ..UsageStatus::default()
        };
        Self {
            inner: Arc::new(Inner {
                root,
                db_path,
                projects,
                emit,
                status: Mutex::new(status),
                last_error: Mutex::new(None),
                started: AtomicBool::new(false),
                scan_pending: AtomicBool::new(false),
            }),
            tx: Mutex::new(None),
        }
    }

    /// Starts ingesting (idempotent): the first call spawns the worker and queues a scan.
    pub fn start(&self) {
        self.inner.started.store(true, Ordering::SeqCst);
        self.send(Msg::Scan);
    }

    /// Stops periodic scans and nudges; a scan in flight stops between files, and the worker then
    /// releases its connection and sleeps.
    pub fn stop(&self) {
        self.inner.started.store(false, Ordering::SeqCst);
        if let Some(tx) = lock(&self.tx).as_ref() {
            let _ = tx.send(Msg::Stop);
        }
    }

    pub fn status(&self) -> UsageStatus {
        let mut status = lock(&self.inner.status).clone();
        status.found = self.inner.root.is_dir();
        status
    }

    /// `Some(reason)` when `usage.db` could not be opened (the `usage-db-unavailable` state).
    pub fn last_error(&self) -> Option<String> {
        lock(&self.inner.last_error).clone()
    }

    /// Ingests one changed session file now. Ignores anything that is not a `.jsonl` under the
    /// sessions directory, or a path that climbs out of it with `..`.
    pub fn nudge(&self, path: &Path) {
        if !self.inner.started.load(Ordering::SeqCst) || !self.accepts(path) {
            return;
        }
        self.send(Msg::Nudge(path.to_path_buf()));
    }

    fn accepts(&self, path: &Path) -> bool {
        path.extension().is_some_and(|e| e == "jsonl")
            && path.starts_with(&self.inner.root)
            && path.components().all(|c| c != Component::ParentDir)
    }

    fn send(&self, msg: Msg) {
        if matches!(msg, Msg::Scan) && self.inner.scan_pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut guard = lock(&self.tx);
        if guard.is_none() {
            let (tx, rx) = channel();
            let inner = Arc::clone(&self.inner);
            let spawned = std::thread::Builder::new()
                .name("usage-ingest".into())
                .spawn(move || worker(&inner, &rx));
            if let Err(e) = spawned {
                *lock(&self.inner.last_error) = Some(format!("usage worker: {e}"));
                self.inner.scan_pending.store(false, Ordering::SeqCst);
                return;
            }
            *guard = Some(tx);
        }
        if let Some(tx) = guard.as_ref() {
            if tx.send(msg).is_err() {
                // The worker is gone; the next call spawns a fresh one.
                *guard = None;
                self.inner.scan_pending.store(false, Ordering::SeqCst);
            }
        }
    }
}

/// Opens a read-only connection for the query layer.
pub fn open_reader() -> Result<Connection, String> {
    schema::open_reader(&paths::usage_db_path()).map_err(|e| e.to_string())
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn worker(inner: &Inner, rx: &Receiver<Msg>) {
    let mut conn: Option<Connection> = None;
    let mut next_scan = Instant::now() + SCAN_INTERVAL;
    loop {
        // Idle (stopped, or no connection yet): block without a timer so nothing rescans.
        let msg = if conn.is_some() && inner.started.load(Ordering::SeqCst) {
            match rx.recv_timeout(next_scan.saturating_duration_since(Instant::now())) {
                Ok(msg) => msg,
                Err(RecvTimeoutError::Timeout) => Msg::Rescan,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        } else {
            match rx.recv() {
                Ok(msg) => msg,
                Err(_) => break,
            }
        };
        let started = inner.started.load(Ordering::SeqCst);
        match msg {
            Msg::Stop => {
                if !started {
                    conn = None;
                }
                continue;
            }
            Msg::Scan | Msg::Rescan | Msg::Nudge(_) if !started => {
                if matches!(msg, Msg::Scan) {
                    inner.scan_pending.store(false, Ordering::SeqCst);
                }
                continue;
            }
            _ => {}
        }
        if conn.is_none() {
            match schema::open_db(&inner.db_path) {
                Ok(c) => {
                    *lock(&inner.last_error) = None;
                    conn = Some(c);
                }
                Err(e) => {
                    *lock(&inner.last_error) = Some(e.to_string());
                    inner.scan_pending.store(false, Ordering::SeqCst);
                    continue;
                }
            }
        }
        let Some(c) = conn.as_mut() else { continue };
        match msg {
            Msg::Scan => {
                inner.scan_pending.store(false, Ordering::SeqCst);
                full_scan(inner, c);
                next_scan = Instant::now() + SCAN_INTERVAL;
            }
            Msg::Rescan => {
                full_scan(inner, c);
                next_scan = Instant::now() + SCAN_INTERVAL;
            }
            Msg::Nudge(path) => nudge_one(inner, c, &path),
            Msg::Stop => {}
        }
    }
}

fn set_status(inner: &Inner, f: impl FnOnce(&mut UsageStatus)) -> UsageStatus {
    let mut status = lock(&inner.status);
    f(&mut status);
    status.clone()
}

fn full_scan(inner: &Inner, conn: &mut Connection) {
    let projects = (inner.projects)();
    if let Err(e) = relabel_all(conn, &inner.root, &projects) {
        log::warn!("usage relabel failed: {e}");
    }
    let found = inner.root.is_dir();
    (inner.emit)(&set_status(inner, |s| {
        s.running = true;
        s.found = found;
        s.sessions_done = 0;
    }));
    let mut last_emit = Instant::now();
    let report = scan::scan(
        conn,
        &inner.root,
        &projects,
        &mut |seen, done| {
            let snapshot = set_status(inner, |s| {
                s.sessions_seen = seen;
                s.sessions_done = done;
            });
            if last_emit.elapsed() >= EMIT_INTERVAL {
                last_emit = Instant::now();
                (inner.emit)(&snapshot);
            }
        },
        &|| !inner.started.load(Ordering::SeqCst),
    );
    (inner.emit)(&set_status(inner, |s| {
        s.running = false;
        s.sessions_seen = report.seen;
        s.sessions_done = report.done;
    }));
}

fn nudge_one(inner: &Inner, conn: &mut Connection, path: &Path) {
    let projects = (inner.projects)();
    let agent = scan::agent_type_for(path, &inner.root);
    loop {
        match ingest::ingest_file(conn, path, agent, &inner.root, &projects) {
            Ok(o) if o.more => continue,
            Ok(o) => {
                if o.new_messages > 0 {
                    let snapshot = lock(&inner.status).clone();
                    (inner.emit)(&snapshot);
                }
                break;
            }
            Err(e) => {
                log::debug!("usage nudge skipped: {e}");
                break;
            }
        }
    }
}

/// Recomputes each file's Project label from its stored `cwd` (a Project was added, renamed or
/// removed) and moves the rollups of every file whose label changed.
fn relabel_all(
    conn: &mut Connection,
    root: &Path,
    projects: &ProjectIndex,
) -> rusqlite::Result<()> {
    let rows: Vec<(String, String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT session_file, cwd, project_label FROM file_offsets \
             WHERE cwd IS NOT NULL AND cwd != ''",
        )?;
        let mapped = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        mapped.collect::<Result<_, _>>()?
    };
    for (file, cwd, old) in rows {
        let new = projects.label(Some(&cwd), Path::new(&file), root);
        if new == old {
            continue;
        }
        let tx = conn.transaction()?;
        rollup::relabel_file(&tx, &file, &new)?;
        tx.execute(
            "UPDATE file_offsets SET project_label = ?1 WHERE session_file = ?2",
            params![new, file],
        )?;
        tx.commit()?;
    }
    Ok(())
}
