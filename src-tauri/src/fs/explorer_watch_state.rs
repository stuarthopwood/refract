// Watcher/session bookkeeping for the File Explorer (lane R7, issue #790): the Rust equivalent
// of `fileExplorer.ts`'s own module-level `watchers`/`loadedPathsBySession`/
// `busySessionRefCounts` maps plus its `ensureWatcher`/`scheduleDirectoryFlush`/
// `refreshDirectory`/`notifyFileExplorerReset`/`forgetFileExplorerSession`/
// `stopFileExplorerWatcher`/`setFileExplorerSessionBusy` functions, and the lifecycle hook
// `ipc::sessions_lifecycle`'s own `sessions.archive`/`.restore`/`.delete`/`.recreateWorktree`
// call into (gate round 1 fix: this wiring was missing entirely; `sessions.ts`:209/300/370 is
// the Electron reference). Lives under `fs/` (this lane's own glob) rather than inside
// `ipc/file_explorer.rs` itself, purely to stay under the 600-line soft cap per file.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

use serde_json::json;
use tauri::AppHandle;
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

use crate::fs::list_directory::{list_directory_entries, ListDirectoryError};
use crate::fs::watch::{watch_directory, DirectoryWatchHandle};
use crate::git::worktree_validity::{worktree_is_valid, WorktreeValidity};
use crate::store::registry::RegistryStore;

type SharedRegistry = Arc<AsyncMutex<RegistryStore>>;

struct SessionWatchState {
    handle: DirectoryWatchHandle,
}

static WATCHERS: LazyLock<StdMutex<HashMap<String, SessionWatchState>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));
static LOADED_PATHS: LazyLock<StdMutex<HashMap<String, HashMap<String, String>>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));
static IN_FLIGHT_KEYS: LazyLock<StdMutex<HashSet<String>>> =
    LazyLock::new(|| StdMutex::new(HashSet::new()));
static DIRTY_KEYS: LazyLock<StdMutex<HashSet<String>>> =
    LazyLock::new(|| StdMutex::new(HashSet::new()));
/// Bounds how many watcher-triggered re-lists run concurrently ACROSS EVERY SESSION'S watcher at
/// once -- mirrors `fileExplorer.ts`'s own `WATCHER_FLUSH_CONCURRENCY = 4`.
static FLUSH_SEMAPHORE: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(4));
/// Mirrors `fileExplorer.ts`'s own `busySessionRefCounts`: a Session a lifecycle operation
/// (archive/delete/recreateWorktree, or a concurrent `ensure_watcher` racing another caller) is
/// mid-way through. `ensure_watcher` refuses to start (or restart) a watcher for a busy Session.
static BUSY_SESSIONS: LazyLock<StdMutex<HashMap<String, u32>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));
/// Per-Session cache of issue #729's `worktree_is_valid` result (perf finding: a watcher-
/// triggered re-list of the root must never spawn a fresh `git worktree list` on every debounced
/// flush). Cleared whenever this module notifies a reset or forgets a Session, so the next check
/// after anything that could change validity is always fresh.
static VALIDITY_CACHE: LazyLock<StdMutex<HashMap<String, WorktreeValidity>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

fn normalize_path_key(relative_path: &str) -> String {
    relative_path.to_lowercase()
}

fn directory_flush_key(session_id: &str, relative_path: &str) -> String {
    format!("{session_id}\0{relative_path}")
}

pub fn record_loaded_path(session_id: &str, relative_path: &str) {
    let mut loaded = LOADED_PATHS.lock().expect("loaded-paths mutex poisoned");
    loaded
        .entry(session_id.to_string())
        .or_default()
        .insert(normalize_path_key(relative_path), relative_path.to_string());
}

pub fn loaded_paths_for(session_id: &str) -> Vec<String> {
    LOADED_PATHS
        .lock()
        .expect("loaded-paths mutex poisoned")
        .get(session_id)
        .map(|m| m.values().cloned().collect())
        .unwrap_or_default()
}

pub fn has_loaded_paths(session_id: &str) -> bool {
    LOADED_PATHS
        .lock()
        .expect("loaded-paths mutex poisoned")
        .contains_key(session_id)
}

/// Mirrors `fileExplorer.ts`'s own `loadedPathsBySession.get(sessionId)?.has(normalizePathKey(...))`
/// guard at the top of `refreshDirectory`: a watcher-triggered re-list only ever refreshes a
/// directory the renderer has actually fetched (via `listDirectory`) at least once -- every other
/// changed folder in a `pnpm install`/build/agent-write burst (e.g. `node_modules`, `target/`,
/// `dist/`) is dropped here rather than re-listed and patched (perf finding).
fn is_loaded(session_id: &str, relative_path: &str) -> bool {
    LOADED_PATHS
        .lock()
        .expect("loaded-paths mutex poisoned")
        .get(session_id)
        .is_some_and(|m| m.contains_key(&normalize_path_key(relative_path)))
}

pub fn forget_file_explorer_session(session_id: &str) {
    LOADED_PATHS
        .lock()
        .expect("loaded-paths mutex poisoned")
        .remove(session_id);
    VALIDITY_CACHE
        .lock()
        .expect("validity cache mutex poisoned")
        .remove(session_id);
}

pub fn has_watcher(session_id: &str) -> bool {
    WATCHERS
        .lock()
        .expect("watchers mutex poisoned")
        .contains_key(session_id)
}

/// Idempotent: a no-op when nothing is watching this Session.
pub fn stop_file_explorer_watcher(session_id: &str) {
    let removed = WATCHERS
        .lock()
        .expect("watchers mutex poisoned")
        .remove(session_id);
    if let Some(state) = removed {
        state.handle.stop();
    }
}

pub fn notify_file_explorer_reset(app_handle: &Arc<StdMutex<Option<AppHandle>>>, session_id: &str) {
    forget_file_explorer_session(session_id);
    let handle = app_handle
        .lock()
        .expect("app handle mutex poisoned")
        .clone();
    if let Some(h) = handle {
        crate::events::emit(
            &h,
            crate::events::FILE_EXPLORER_RESET,
            json!({ "sessionId": session_id }),
        );
    }
}

fn mark_session_busy(session_id: &str) {
    let mut busy = BUSY_SESSIONS.lock().expect("busy mutex poisoned");
    *busy.entry(session_id.to_string()).or_insert(0) += 1;
}

fn unmark_session_busy(session_id: &str) {
    let mut busy = BUSY_SESSIONS.lock().expect("busy mutex poisoned");
    if let Some(count) = busy.get_mut(session_id) {
        if *count <= 1 {
            busy.remove(session_id);
        } else {
            *count -= 1;
        }
    }
}

/// Gate round 1 item 1 (#464 git-changes watcher lifecycle): widened to `pub(crate)` so
/// `fs::git_changes_watch_state::ensure_watcher` can refuse to (re)start its own per-Session
/// watcher while a lifecycle operation (archive/delete/recreateWorktree) holds this same busy
/// claim, rather than inventing a second busy-session mechanism.
pub(crate) fn is_session_busy(session_id: &str) -> bool {
    BUSY_SESSIONS
        .lock()
        .expect("busy mutex poisoned")
        .contains_key(session_id)
}

/// The number of concurrent "busy" claims on `session_id` right now (0 if none). Lets
/// `ensure_watcher`'s own final re-check (gate round 2 fix) tell "just my own claim" (1) apart
/// from "someone else -- a lifecycle operation -- also claimed busy while I was inside
/// `watch_directory`" (> 1), since `is_session_busy` alone cannot distinguish the two.
fn busy_count(session_id: &str) -> u32 {
    BUSY_SESSIONS
        .lock()
        .expect("busy mutex poisoned")
        .get(session_id)
        .copied()
        .unwrap_or(0)
}

/// What a Session-lifecycle handler tells the renderer once it finishes, via
/// `WorktreeOperationGuard::finish` -- `Reset` for archive/restore/recreateWorktree (the tree is
/// stale, re-check it), `Forgotten` for delete (the Session itself is gone).
pub enum WorktreeOperationOutcome {
    Reset,
    Forgotten,
}

/// RAII guard returned by `begin_worktree_operation`. `finish` is the success path (clears busy,
/// then resets or forgets). Gate round 2 fix: dropping it WITHOUT calling `finish` (a FAILED
/// lifecycle operation, via an early `?` return) now also resets, not just clears busy --
/// `begin_worktree_operation` already stopped the watcher before the operation was attempted, so
/// a failure still leaves the Explorer with no watcher underneath a now-possibly-stale tree;
/// Electron's own `sessions.ts` resets in exactly this situation (archive's outer `finally`,
/// :228-234; a failed delete that still has a Session row, :341-347; recreate's `catch`,
/// :380-388). For `sessions_delete` specifically: its own handler never removes the registry row
/// before any OTHER fallible step (`remove_session` is the LAST one), so every path that drops
/// this guard unfinished still has the Session row present -- a Drop-triggered reset here never
/// targets an already-gone Session.
#[must_use]
pub struct WorktreeOperationGuard {
    session_id: String,
    app_handle: Arc<StdMutex<Option<AppHandle>>>,
    finished: bool,
}

impl WorktreeOperationGuard {
    pub fn finish(mut self, outcome: WorktreeOperationOutcome) {
        self.finished = true;
        unmark_session_busy(&self.session_id);
        match outcome {
            WorktreeOperationOutcome::Forgotten => forget_file_explorer_session(&self.session_id),
            WorktreeOperationOutcome::Reset => {
                notify_file_explorer_reset(&self.app_handle, &self.session_id)
            }
        }
    }
}

impl Drop for WorktreeOperationGuard {
    fn drop(&mut self) {
        if !self.finished {
            unmark_session_busy(&self.session_id);
            notify_file_explorer_reset(&self.app_handle, &self.session_id);
        }
    }
}

/// Called by `sessions.archive`/`.delete`/`.recreateWorktree` BEFORE they touch the worktree:
/// marks the Session busy FIRST (gate round 2 fix: narrows the window a concurrent
/// `ensure_watcher` could still slip a watcher in between "stopped" and "marked busy"), then
/// stops any running watcher (PR #671 round 4 Critical: a watcher holding the root open makes
/// `recreateWorktree`'s own folder creation fail with `EPERM`). Returns a guard the caller must
/// `finish` on success; dropping it unfinished (failure) still resets -- see the guard's own doc
/// comment.
pub fn begin_worktree_operation(
    app_handle: Arc<StdMutex<Option<AppHandle>>>,
    session_id: &str,
) -> WorktreeOperationGuard {
    mark_session_busy(session_id);
    stop_file_explorer_watcher(session_id);
    WorktreeOperationGuard {
        session_id: session_id.to_string(),
        app_handle,
        finished: false,
    }
}

/// Issue #729's validity check. Caches ONLY a `Valid` result, per Session, until the next
/// reset/forget (gate round 2 fix): an `Invalid`/`Unknown` answer is never cached, so a user who
/// repairs the worktree outside the app (restores the folder, runs `git worktree repair`) and
/// hits Retry always sees the live, current answer -- the perf concern this cache exists for
/// (`git worktree list` on every watcher-triggered re-list) only ever matters for an ACTIVELY
/// WATCHED, valid Session with high file churn; an invalid one has no watcher doing repeated
/// churn-driven re-lists in the first place, so never caching its failure costs nothing on the
/// hot path this cache was built to protect.
pub async fn cached_worktree_validity(
    session_id: &str,
    repo_path: &Path,
    worktree_path: &Path,
) -> WorktreeValidity {
    if let Some(cached) = VALIDITY_CACHE
        .lock()
        .expect("validity cache mutex poisoned")
        .get(session_id)
        .copied()
    {
        return cached;
    }
    let validity = worktree_is_valid(repo_path, worktree_path).await;
    if validity == WorktreeValidity::Valid {
        VALIDITY_CACHE
            .lock()
            .expect("validity cache mutex poisoned")
            .insert(session_id.to_string(), validity);
    }
    validity
}

fn watcher_still_current(session_id: &str, expected: &DirectoryWatchHandle) -> bool {
    WATCHERS
        .lock()
        .expect("watchers mutex poisoned")
        .get(session_id)
        .is_some_and(|state| state.handle.same_as(expected))
}

/// Captures the current watcher handle for `session_id` (if any) by identity, so a caller can
/// later prove the watcher it started still exists AFTER an `await` (mirrors `fileExplorer.ts`'s
/// own `watchedHandle` capture around `listDirectory`'s `ensureWatcher`/`listDirectoryEntries`
/// pair).
pub fn watcher_handle(session_id: &str) -> Option<DirectoryWatchHandle> {
    WATCHERS
        .lock()
        .expect("watchers mutex poisoned")
        .get(session_id)
        .map(|s| s.handle.clone())
}

pub fn watcher_matches(session_id: &str, expected: &DirectoryWatchHandle) -> bool {
    watcher_still_current(session_id, expected)
}

/// Re-checks a Session still exists and is not archived -- `None` registry means "not wired"
/// (every unit test in this file), treated as "proceed" so existing tests are unaffected.
async fn session_is_live(registry: Option<&SharedRegistry>, session_id: &str) -> bool {
    let Some(registry) = registry else {
        return true;
    };
    let registry = registry.lock().await;
    registry
        .get_session(session_id)
        .map(|s| s.archived_at.is_none())
        .unwrap_or(false)
}

#[allow(clippy::too_many_arguments)]
async fn refresh_directory(
    app_handle: Arc<StdMutex<Option<AppHandle>>>,
    registry: Option<SharedRegistry>,
    repo_path: Option<PathBuf>,
    worktree_path: PathBuf,
    session_id: String,
    relative_path: String,
    expected_handle: DirectoryWatchHandle,
) {
    // Mirrors `fileExplorer.ts`'s own `refreshDirectory` guards, run BEFORE any I/O.
    if !is_loaded(&session_id, &relative_path) {
        return;
    }
    if !session_is_live(registry.as_ref(), &session_id).await {
        return;
    }
    if !watcher_still_current(&session_id, &expected_handle) {
        return;
    }
    let _permit = FLUSH_SEMAPHORE.acquire().await;
    if !watcher_still_current(&session_id, &expected_handle) {
        return;
    }
    let result = list_directory_entries(
        &session_id,
        repo_path.as_deref(),
        &worktree_path,
        &relative_path,
    )
    .await;
    if !watcher_still_current(&session_id, &expected_handle) {
        return;
    }
    match result {
        Ok(ok) => {
            let handle = app_handle
                .lock()
                .expect("app handle mutex poisoned")
                .clone();
            if let Some(h) = handle {
                crate::events::emit(
                    &h,
                    crate::events::FILE_EXPLORER_PATCH,
                    json!({
                        "sessionId": session_id,
                        "relativePath": relative_path,
                        "entries": ok.entries,
                        "truncated": ok.truncated,
                    }),
                );
            }
        }
        Err(ListDirectoryError::WorktreeMissing) => {
            // Mirrors `fileExplorer.ts`'s own round-7 fix: a background refresh that discovers
            // the worktree itself is gone stops watching and tells the renderer, rather than
            // silently dropping the patch and leaving a watcher running against a dead root.
            stop_file_explorer_watcher(&session_id);
            notify_file_explorer_reset(&app_handle, &session_id);
        }
        Err(_) => {
            // Any other re-list failure is swallowed (mirrors `fileExplorer.ts`'s own
            // `refreshDirectory` catch): no patch for this cycle, the next debounced change or an
            // explicit `listDirectory` call tries again.
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn schedule_directory_flush(
    runtime: tokio::runtime::Handle,
    app_handle: Arc<StdMutex<Option<AppHandle>>>,
    registry: Option<SharedRegistry>,
    repo_path: Option<PathBuf>,
    worktree_path: PathBuf,
    session_id: String,
    relative_path: String,
    expected_handle: DirectoryWatchHandle,
) {
    let key = directory_flush_key(&session_id, &relative_path);
    {
        let mut in_flight = IN_FLIGHT_KEYS.lock().expect("in-flight mutex poisoned");
        if in_flight.contains(&key) {
            DIRTY_KEYS.lock().expect("dirty mutex poisoned").insert(key);
            return;
        }
        in_flight.insert(key.clone());
    }
    let runtime_for_rerun = runtime.clone();
    runtime.spawn(async move {
        refresh_directory(
            app_handle.clone(),
            registry.clone(),
            repo_path.clone(),
            worktree_path.clone(),
            session_id.clone(),
            relative_path.clone(),
            expected_handle.clone(),
        )
        .await;
        IN_FLIGHT_KEYS
            .lock()
            .expect("in-flight mutex poisoned")
            .remove(&key);
        if DIRTY_KEYS
            .lock()
            .expect("dirty mutex poisoned")
            .remove(&key)
        {
            schedule_directory_flush(
                runtime_for_rerun,
                app_handle,
                registry,
                repo_path,
                worktree_path,
                session_id,
                relative_path,
                expected_handle,
            );
        }
    });
}

/// Starts a watcher for `session_id` if one is not already running, never for an archived,
/// busy, or already-missing-worktree Session. Idempotent AND race-free (gate round 1 fix): the
/// membership check and the busy-claim happen under one held lock before any I/O, so two
/// concurrent callers for the same Session can never both reach `watch_directory` -- the second
/// sees `is_session_busy` (or, after the first inserts, `has_watcher`) and returns immediately. A
/// residual window (the first caller's own `watch_directory` call, which cannot itself run under
/// a lock held across a blocking OS call) is closed by a final re-check-under-lock before the
/// insert: a loser stops its own just-created watcher rather than replacing the winner's, so
/// nothing is ever orphaned outside `WATCHERS` (the gate-round-1 leak: an orphaned handle's
/// `RecommendedWatcher`/`tx` keep its background thread alive forever with no way to reach it).
#[allow(clippy::too_many_arguments)]
pub fn ensure_watcher(
    runtime: tokio::runtime::Handle,
    app_handle: Arc<StdMutex<Option<AppHandle>>>,
    registry: Option<SharedRegistry>,
    session_id: &str,
    worktree_path: &Path,
    repo_path: Option<PathBuf>,
    archived: bool,
) {
    {
        let watchers = WATCHERS.lock().expect("watchers mutex poisoned");
        if archived || is_session_busy(session_id) || watchers.contains_key(session_id) {
            return;
        }
        // Gate round 2 fix: the busy claim is now taken WHILE STILL HOLDING the same lock the
        // membership/busy check above just ran under, closing the window a concurrent
        // `begin_worktree_operation` (a lifecycle operation) could slip its OWN busy claim
        // between this check and this claim and then proceed to stop a watcher that does not
        // exist yet, only for this call to insert a fresh one on a Session being archived or
        // deleted.
        mark_session_busy(session_id);
    }
    struct BusyRelease<'a>(&'a str);
    impl Drop for BusyRelease<'_> {
        fn drop(&mut self) {
            unmark_session_busy(self.0);
        }
    }
    let _release = BusyRelease(session_id);

    let handle_cell: Arc<StdMutex<Option<DirectoryWatchHandle>>> = Arc::new(StdMutex::new(None));

    let on_changed = {
        let session_id = session_id.to_string();
        let worktree_path = worktree_path.to_path_buf();
        let repo_path = repo_path.clone();
        let registry = registry.clone();
        let runtime = runtime.clone();
        let app_handle = app_handle.clone();
        let handle_cell = handle_cell.clone();
        move |relative_path: String| {
            let Some(expected) = handle_cell.lock().expect("handle cell poisoned").clone() else {
                return;
            };
            schedule_directory_flush(
                runtime.clone(),
                app_handle.clone(),
                registry.clone(),
                repo_path.clone(),
                worktree_path.clone(),
                session_id.clone(),
                relative_path,
                expected,
            );
        }
    };

    let on_fatal = {
        let session_id = session_id.to_string();
        let app_handle = app_handle.clone();
        let handle_cell = handle_cell.clone();
        move || {
            let Some(expected) = handle_cell.lock().expect("handle cell poisoned").clone() else {
                return;
            };
            {
                let mut watchers = WATCHERS.lock().expect("watchers mutex poisoned");
                match watchers.get(&session_id) {
                    Some(state) if state.handle.same_as(&expected) => {
                        watchers.remove(&session_id);
                    }
                    _ => return,
                }
            }
            notify_file_explorer_reset(&app_handle, &session_id);
        }
    };

    let Some(handle) = watch_directory(worktree_path, on_changed, on_fatal) else {
        return;
    };
    *handle_cell.lock().expect("handle cell poisoned") = Some(handle.clone());
    let mut watchers = WATCHERS.lock().expect("watchers mutex poisoned");
    // Gate round 2 fix: `busy_count(session_id) > 1` means someone OTHER than our own
    // `_release` claim also marked this Session busy while `watch_directory` was in flight --
    // the only other caller of `mark_session_busy` is `begin_worktree_operation` (a lifecycle
    // operation), since a second concurrent `ensure_watcher` call would have returned early at
    // the membership/busy check above instead of claiming its own count. Back off rather than
    // insert a watcher on a Session a lifecycle operation is (or is about to start) touching.
    if watchers.contains_key(session_id) || busy_count(session_id) > 1 {
        drop(watchers);
        handle.stop();
        return;
    }
    watchers.insert(session_id.to_string(), SessionWatchState { handle });
}

/// `fileExplorer.ensureWatching`'s own post-start re-flush: when a FRESH handle actually starts
/// (not a no-op on an already-running watcher), re-schedules every directory
/// `loaded_paths_for(session_id)` still remembers the renderer having open.
#[allow(clippy::too_many_arguments)]
pub fn reflush_loaded_paths(
    runtime: tokio::runtime::Handle,
    app_handle: Arc<StdMutex<Option<AppHandle>>>,
    registry: Option<SharedRegistry>,
    session_id: &str,
    worktree_path: &Path,
    repo_path: Option<PathBuf>,
) {
    let Some(handle) = WATCHERS
        .lock()
        .expect("watchers mutex poisoned")
        .get(session_id)
        .map(|s| s.handle.clone())
    else {
        return;
    };
    for relative_path in loaded_paths_for(session_id) {
        schedule_directory_flush(
            runtime.clone(),
            app_handle.clone(),
            registry.clone(),
            repo_path.clone(),
            worktree_path.to_path_buf(),
            session_id.to_string(),
            relative_path,
            handle.clone(),
        );
    }
}

#[cfg(test)]
#[path = "explorer_watch_state_tests.rs"]
mod tests;
