// Debounced per-directory watcher. Fatal on a watcher error, a removed root, or a root that
// vanishes with no event (a Windows `notify` gap), detected by a periodic liveness poll.

use std::collections::{HashSet, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use crate::fs::paths::contains_git_segment;

const WATCH_DEBOUNCE_MS: u64 = 200;
/// Wake interval for the root-exists check; `notify` may emit no event when an empty root is removed.
const ROOT_LIVENESS_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Handle to stop a watcher. `same_as` lets stale callbacks detect a replaced watcher.
#[derive(Clone)]
pub struct DirectoryWatchHandle {
    inner: Arc<StdMutex<Option<RecommendedWatcher>>>,
}

impl DirectoryWatchHandle {
    /// Drops the native watch and any unflushed directories. Safe to call twice.
    pub fn stop(&self) {
        *self.inner.lock().expect("watch handle mutex poisoned") = None;
    }

    /// True when both handles refer to the same watcher.
    pub fn same_as(&self, other: &DirectoryWatchHandle) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
}

/// POSIX-relative parent directory of `changed_path`. `None` for `.git` paths or paths outside `root`.
fn relative_directory_for(root: &Path, changed_path: &Path) -> Option<String> {
    let rel = changed_path.strip_prefix(root).ok()?;
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    if contains_git_segment(&rel_str) {
        return None;
    }
    match rel_str.rsplit_once('/') {
        Some((parent, _)) => Some(parent.to_string()),
        None => Some(String::new()),
    }
}

/// Watches the subtree of `worktree_root`. Calls `on_fatal` at most once; `None` if unwatchable.
pub fn watch_directory<F, G>(
    worktree_root: &Path,
    on_directory_changed: F,
    on_fatal: G,
) -> Option<DirectoryWatchHandle>
where
    F: Fn(String) + Send + Sync + 'static,
    G: Fn() + Send + Sync + 'static,
{
    watch_directory_with_debounce(
        worktree_root,
        on_directory_changed,
        on_fatal,
        Duration::from_millis(WATCH_DEBOUNCE_MS),
        true,
    )
}

/// Like `watch_directory`, but never re-queues the root on liveness ticks (#464); the fatal check still runs.
pub fn watch_directory_without_liveness_requeue<F, G>(
    worktree_root: &Path,
    on_directory_changed: F,
    on_fatal: G,
) -> Option<DirectoryWatchHandle>
where
    F: Fn(String) + Send + Sync + 'static,
    G: Fn() + Send + Sync + 'static,
{
    watch_directory_with_debounce(
        worktree_root,
        on_directory_changed,
        on_fatal,
        Duration::from_millis(WATCH_DEBOUNCE_MS),
        false,
    )
}

fn watch_directory_with_debounce<F, G>(
    worktree_root: &Path,
    on_directory_changed: F,
    on_fatal: G,
    debounce: Duration,
    requeue_root_on_liveness: bool,
) -> Option<DirectoryWatchHandle>
where
    F: Fn(String) + Send + Sync + 'static,
    G: Fn() + Send + Sync + 'static,
{
    let root = worktree_root.to_path_buf();
    let fired_fatal = Arc::new(AtomicBool::new(false));

    let (tx, rx) = std_mpsc::channel::<notify::Result<Event>>();
    let mut watcher = match notify::recommended_watcher(move |res: notify::Result<Event>| {
        let _ = tx.send(res);
    }) {
        Ok(w) => w,
        Err(_) => return None,
    };
    if watcher.watch(&root, RecursiveMode::Recursive).is_err() {
        return None;
    }

    let inner = Arc::new(StdMutex::new(Some(watcher)));
    let handle = DirectoryWatchHandle { inner };

    let root_for_thread = root.clone();
    std::thread::spawn(move || {
        let mut pending: HashSet<String> = HashSet::new();
        let mut deadline: Option<Instant> = None;
        let mut last_liveness_check = Instant::now();
        loop {
            // Checked every iteration so a continuous event burst cannot starve the flush or the poll.
            if let Some(d) = deadline {
                if Instant::now() >= d {
                    for dir in pending.drain() {
                        on_directory_changed(dir);
                    }
                    deadline = None;
                }
            }
            if last_liveness_check.elapsed() >= ROOT_LIVENESS_POLL_INTERVAL {
                last_liveness_check = Instant::now();
                if !root_for_thread.exists() {
                    if !fired_fatal.swap(true, Ordering::SeqCst) {
                        on_fatal();
                    }
                    return;
                }
                // Self-heal a silently stalled watch by re-queuing the root through the debounce.
                // Skipped when `requeue_root_on_liveness` is false (#464).
                if requeue_root_on_liveness {
                    pending.insert(String::new());
                    if deadline.is_none() {
                        deadline = Some(Instant::now() + debounce);
                    }
                }
            }

            let wait = match deadline {
                Some(d) => d
                    .saturating_duration_since(Instant::now())
                    .min(ROOT_LIVENESS_POLL_INTERVAL),
                None => ROOT_LIVENESS_POLL_INTERVAL
                    .saturating_sub(last_liveness_check.elapsed())
                    .max(Duration::from_millis(1)),
            };
            match rx.recv_timeout(wait) {
                Ok(Ok(event)) => {
                    let is_root_removed = matches!(event.kind, EventKind::Remove(_))
                        && event.paths.iter().any(|p| p == &root_for_thread);
                    if is_root_removed {
                        if !fired_fatal.swap(true, Ordering::SeqCst) {
                            on_fatal();
                        }
                        return;
                    }
                    let mut queued = VecDeque::new();
                    for path in &event.paths {
                        if let Some(rel) = relative_directory_for(&root_for_thread, path) {
                            queued.push_back(rel);
                        }
                    }
                    if !queued.is_empty() {
                        for rel in queued.drain(..) {
                            pending.insert(rel);
                        }
                        if deadline.is_none() {
                            deadline = Some(Instant::now() + debounce);
                        }
                    }
                }
                Ok(Err(_notify_err)) => {
                    // Any notify error is fatal.
                    if !fired_fatal.swap(true, Ordering::SeqCst) {
                        on_fatal();
                    }
                    return;
                }
                Err(std_mpsc::RecvTimeoutError::Timeout) => {
                }
                Err(std_mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    });

    Some(handle)
}

#[cfg(test)]
#[path = "watch_tests.rs"]
mod tests;
