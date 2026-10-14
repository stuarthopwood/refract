// Watcher/session bookkeeping for the File Explorer (lane R7, issue #790): the Rust equivalent
// of `fileExplorer.ts`'s own module-level `watchers`/`loadedPathsBySession` maps plus its
// `ensureWatcher`/`scheduleDirectoryFlush`/`refreshDirectory`/`notifyFileExplorerReset`/
// `forgetFileExplorerSession`/`stopFileExplorerWatcher` functions. Lives under `fs/` (this
// lane's own glob) rather than inside `ipc/file_explorer.rs` itself, purely to stay under the
// 600-line soft cap per file -- logically still part of that handler module.
//
// Known, documented gap (see `ipc/sessions_lifecycle.rs`'s own header comment, lane R2/#785,
// already merged): `sessions.archive`/`.delete`/`.recreateWorktree` do not call into this
// module's `stop_file_explorer_watcher`/`notify_file_explorer_reset`/
// `forget_file_explorer_session` the way the TS `sessions.ts` does (that file is owned by an
// already-merged lane; adding a cross-lane call there is out of this lane's scope). Mitigated
// here instead: `ensure_watcher` always re-checks `archived` at call time (so a reload of an
// archived Session's panel never restarts a watcher), and the watcher's own `on_fatal` path
// (root deleted or made unwatchable) independently tears itself down and resets -- the one gap
// that remains is a watcher staying open a little longer than strictly necessary across an
// archive/delete that happens while no Explorer call runs, not an incorrect LISTING or a security
// boundary; recorded as a PR follow-up.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

use serde_json::json;
use tauri::AppHandle;
use tokio::sync::Semaphore;

use crate::fs::list_directory::list_directory_entries;
use crate::fs::watch::{watch_directory, DirectoryWatchHandle};

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

pub fn forget_file_explorer_session(session_id: &str) {
    LOADED_PATHS
        .lock()
        .expect("loaded-paths mutex poisoned")
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

async fn refresh_directory(
    app_handle: Arc<StdMutex<Option<AppHandle>>>,
    repo_path: Option<PathBuf>,
    worktree_path: PathBuf,
    session_id: String,
    relative_path: String,
    expected_handle: DirectoryWatchHandle,
) {
    let _permit = FLUSH_SEMAPHORE.acquire().await;
    if !watcher_still_current(&session_id, &expected_handle) {
        return;
    }
    let result = list_directory_entries(repo_path.as_deref(), &worktree_path, &relative_path).await;
    if !watcher_still_current(&session_id, &expected_handle) {
        return;
    }
    if let Ok(ok) = result {
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
    // A re-list failure is swallowed here (mirrors `fileExplorer.ts`'s own `refreshDirectory`
    // catch): no patch for this cycle, the next debounced change or an explicit `listDirectory`
    // call tries again.
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

#[allow(clippy::too_many_arguments)]
fn schedule_directory_flush(
    runtime: tokio::runtime::Handle,
    app_handle: Arc<StdMutex<Option<AppHandle>>>,
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
                repo_path,
                worktree_path,
                session_id,
                relative_path,
                expected_handle,
            );
        }
    });
}

/// Starts a watcher for `session_id` if one is not already running, never for an archived or
/// already-missing-worktree Session. Idempotent.
pub fn ensure_watcher(
    runtime: tokio::runtime::Handle,
    app_handle: Arc<StdMutex<Option<AppHandle>>>,
    session_id: &str,
    worktree_path: &Path,
    repo_path: Option<PathBuf>,
    archived: bool,
) {
    if archived || has_watcher(session_id) {
        return;
    }
    let handle_cell: Arc<StdMutex<Option<DirectoryWatchHandle>>> = Arc::new(StdMutex::new(None));

    let on_changed = {
        let session_id = session_id.to_string();
        let worktree_path = worktree_path.to_path_buf();
        let repo_path = repo_path.clone();
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
    WATCHERS
        .lock()
        .expect("watchers mutex poisoned")
        .insert(session_id.to_string(), SessionWatchState { handle });
}

/// `fileExplorer.ensureWatching`'s own post-start re-flush: when a FRESH handle actually starts
/// (not a no-op on an already-running watcher), re-schedules every directory
/// `loaded_paths_for(session_id)` still remembers the renderer having open.
#[allow(clippy::too_many_arguments)]
pub fn reflush_loaded_paths(
    runtime: tokio::runtime::Handle,
    app_handle: Arc<StdMutex<Option<AppHandle>>>,
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
            repo_path.clone(),
            worktree_path.to_path_buf(),
            session_id.to_string(),
            relative_path,
            handle.clone(),
        );
    }
}
