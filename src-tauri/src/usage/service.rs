// The Usage ingest service: one thread owns the writer connection to `usage.db`. It is started at
// app launch, scans then and every five minutes, and ingests single files on `nudge`.

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde::Serialize;

use super::project_label::ProjectIndex;
use super::{ingest, paths, relabel, scan, schema};

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
    pub scan_completed: bool,
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
}

struct Inner {
    root: PathBuf,
    db_path: PathBuf,
    projects: ProjectsProvider,
    emit: StatusEmit,
    status: Mutex<UsageStatus>,
    last_error: Mutex<Option<String>>,
    scan_pending: AtomicBool,
    /// The index the stored labels were last recomputed under.
    labelled: Mutex<Option<ProjectIndex>>,
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
                scan_pending: AtomicBool::new(false),
                labelled: Mutex::new(None),
            }),
            tx: Mutex::new(None),
        }
    }

    /// Starts ingesting (idempotent): the first call spawns the worker, each call queues a scan.
    pub fn start(&self) {
        self.send(Msg::Scan);
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
        if !self.accepts(path) {
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
                mark_scan_completed(&self.inner);
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
        let msg = match rx.recv_timeout(next_scan.saturating_duration_since(Instant::now())) {
            Ok(msg) => msg,
            Err(RecvTimeoutError::Timeout) => Msg::Rescan,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        if conn.is_none() {
            match schema::open_db(&inner.db_path) {
                Ok(c) => {
                    *lock(&inner.last_error) = None;
                    conn = Some(c);
                }
                Err(e) => {
                    log::warn!("usage db unavailable: {e}");
                    *lock(&inner.last_error) = Some(e.to_string());
                    inner.scan_pending.store(false, Ordering::SeqCst);
                    next_scan = Instant::now() + SCAN_INTERVAL;
                    mark_scan_completed(inner);
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
        }
    }
}

fn set_status(inner: &Inner, f: impl FnOnce(&mut UsageStatus)) -> UsageStatus {
    let mut status = lock(&inner.status);
    f(&mut status);
    status.clone()
}

/// Flips `scan_completed` and emits once, so a database that stays unavailable does not re-emit on every nudge.
fn mark_scan_completed(inner: &Inner) {
    let mut flipped = false;
    let snapshot = set_status(inner, |s| flipped = !std::mem::replace(&mut s.scan_completed, true));
    if flipped {
        (inner.emit)(&snapshot);
    }
}

fn full_scan(inner: &Inner, conn: &mut Connection) {
    let projects = (inner.projects)();
    run_relabel(inner, conn, &projects);
    let found = inner.root.is_dir();
    (inner.emit)(&set_status(inner, |s| {
        s.running = true;
        s.found = found;
        s.sessions_done = 0;
    }));
    let mut last_emit = Instant::now();
    let report = scan::scan(conn, &inner.root, &projects, &mut |seen, done| {
        let snapshot = set_status(inner, |s| {
            s.sessions_seen = seen;
            s.sessions_done = done;
        });
        if last_emit.elapsed() >= EMIT_INTERVAL {
            last_emit = Instant::now();
            (inner.emit)(&snapshot);
        }
    });
    // Files ingested above were labelled one by one; this merges case-duplicate folder rows.
    run_relabel(inner, conn, &projects);
    (inner.emit)(&set_status(inner, |s| {
        s.running = false;
        s.sessions_seen = report.seen;
        s.sessions_done = report.done;
        s.scan_completed = true;
    }));
}

/// Relabels stored rows when the registry changed since the last relabel, so a Project added
/// between scans takes effect on the next ingested message rather than the next full scan.
fn relabel_if_changed(inner: &Inner, conn: &mut Connection, projects: &ProjectIndex) {
    if lock(&inner.labelled).as_ref() != Some(projects) {
        run_relabel(inner, conn, projects);
    }
}

fn run_relabel(inner: &Inner, conn: &mut Connection, projects: &ProjectIndex) {
    match relabel::relabel(conn, &inner.root, projects) {
        Ok(()) => *lock(&inner.labelled) = Some(projects.clone()),
        Err(e) => log::warn!("usage relabel failed: {e}"),
    }
}

fn nudge_one(inner: &Inner, conn: &mut Connection, path: &Path) {
    let projects = (inner.projects)();
    relabel_if_changed(inner, conn, &projects);
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
