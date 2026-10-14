// Port of `src/main/fs/watchDirectory.ts` (lane R7, issue #790): watches a worktree's whole
// subtree and reports, via a debounced callback, which single directory (relative to the root,
// POSIX `/`-separated, matching `FileTreeNode.path`'s own convention) needs re-listing. Built on
// the `notify` crate (not already in `Cargo.lock`, added minimally in `Cargo.toml`), whose
// `RecommendedWatcher` wraps `ReadDirectoryChangesW` on Windows -- the same underlying API the TS
// original's own `fs.watch({ recursive: true })` uses.
//
// **Adaptation, not a literal port** (worth stating plainly): the TS original detects "the
// watched root was deleted out from under a running watch" via a low-level Node quirk -- an
// ABSOLUTE `filename` in a raw `fs.watch` callback, which Node documents as always relative, so
// an absolute one is itself the fatal signal (`ReadDirectoryChangesW` floods relative-looking
// events otherwise). `notify` abstracts that raw buffer away entirely: every event it reports
// already carries absolute, already-parsed `PathBuf`s, so there is no "absolute when it should be
// relative" signal left to detect; worse, a live probe on this machine found `notify`'s Windows
// backend emits **no event and no error at all** when an already-empty watched root is removed
// out from under the watch (`ReadDirectoryChangesW`'s own handle presumably just goes quietly
// invalid). This port instead treats THREE things as fatal, matching the TS original's
// OBSERVABLE behaviour (stop once, call `on_fatal` once, never spin): (1) any `Err` from `notify`
// itself (mirrors the TS `watcher.on('error', fail)` -- always fatal, no second-guessing), (2) a
// `Remove` event whose path is the watched root itself (a cheap exact path comparison, kept as a
// fast path for whichever backend/condition DOES surface it), and (3) a periodic liveness poll
// (`ROOT_LIVENESS_POLL_INTERVAL`) that checks the root still exists even with no events at all --
// the actual mechanism that fires for the reproduced case above, bounding worst-case detection
// latency to that interval rather than relying on a signal that may never arrive.
//
// Debounce: a trailing-edge timer started at the FIRST event of a burst (not reset by every
// subsequent event, which would let a continuous burst delay the flush indefinitely) -- mirrors
// `watchDirectory.ts`'s own `queueDirectory` (`if (flushTimer) return;`), bounding worst-case
// re-list latency to `WATCH_DEBOUNCE_MS` regardless of burst length.

use std::collections::{HashSet, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use crate::fs::paths::contains_git_segment;

const WATCH_DEBOUNCE_MS: u64 = 200;
/// How often the watcher thread wakes, even with no pending event, to check whether the watched
/// root itself still exists -- the fatal-detection fallback this file's own header comment
/// describes (a live probe found `notify` emits no event at all for an already-empty root
/// removed out from under a Windows watch). Bounds worst-case detection latency to this value.
const ROOT_LIVENESS_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Returned by `watch_directory`; the caller's one way to tear down a Session's watcher. Clone is
/// cheap (an `Arc`) and comparable by identity (`DirectoryWatchHandle::same_as`), matching
/// `watchDirectory.ts`'s own handle-identity guards throughout `fileExplorer.ts` (a stale
/// callback from an already-replaced watcher must never act on the new one's state).
#[derive(Clone)]
pub struct DirectoryWatchHandle {
    inner: Arc<StdMutex<Option<RecommendedWatcher>>>,
}

impl DirectoryWatchHandle {
    /// Stops watching immediately (drops the native watch), discarding any not-yet-flushed
    /// debounced directories. Safe to call more than once.
    pub fn stop(&self) {
        *self.inner.lock().expect("watch handle mutex poisoned") = None;
    }

    pub fn same_as(&self, other: &DirectoryWatchHandle) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
}

/// POSIX-relative directory containing `path` (mirrors `watchDirectory.ts`'s own
/// `toRelativeDirectory`): the PARENT of whatever entry changed, so the caller re-lists the
/// directory that gained/lost/renamed that entry. `None` when the changed path is under `.git`
/// (FR-007: never queue a re-list for it) or does not fall under `root` at all (a notify quirk
/// reporting a sibling path, defensively ignored rather than panicking).
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

/// Watches `worktree_root`'s whole subtree and reports, via `on_directory_changed`, which single
/// directory needs re-listing; calls `on_fatal` at most once if the watch itself becomes
/// unusable (the root was deleted, or `notify` reports an error). Returns `None` when the root
/// does not exist (or is otherwise unwatchable) at call time -- the caller must not cache that as
/// a handle, so the next `listDirectory`-equivalent call retries instead of staying silently
/// un-watched forever.
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
    )
}

fn watch_directory_with_debounce<F, G>(
    worktree_root: &Path,
    on_directory_changed: F,
    on_fatal: G,
    debounce: Duration,
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
        loop {
            let wait = match deadline {
                Some(d) => d
                    .saturating_duration_since(Instant::now())
                    .min(ROOT_LIVENESS_POLL_INTERVAL),
                // No pending burst: still wake periodically (never block indefinitely) to poll
                // whether the watched root itself still exists -- see this file's own doc
                // comment: a live probe on this machine found `notify` emits NO event at all
                // (not even an error) when an already-empty watched root is removed out from
                // under the watch, so an event- or error-driven signal alone is not sufficient.
                None => ROOT_LIVENESS_POLL_INTERVAL,
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
                    // Mirrors `watchDirectory.ts`'s own `watcher.on('error', fail)`: any genuine
                    // notify-level error is always fatal, no second-guessing.
                    if !fired_fatal.swap(true, Ordering::SeqCst) {
                        on_fatal();
                    }
                    return;
                }
                Err(std_mpsc::RecvTimeoutError::Timeout) => {
                    if let Some(d) = deadline {
                        if Instant::now() >= d {
                            for dir in pending.drain() {
                                on_directory_changed(dir);
                            }
                            deadline = None;
                        }
                    }
                    if !root_for_thread.exists() {
                        if !fired_fatal.swap(true, Ordering::SeqCst) {
                            on_fatal();
                        }
                        return;
                    }
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
