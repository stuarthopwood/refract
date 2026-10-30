// Watcher and session bookkeeping for the File Explorer (#790).
// Lives under `fs/` to keep `ipc/file_explorer.rs` under the 600-line cap.

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
/// Caps concurrent watcher-triggered re-lists across all sessions.
static FLUSH_SEMAPHORE: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(4));
/// Sessions mid-way through a lifecycle operation. `ensure_watcher` will not start a watcher for them.
static BUSY_SESSIONS: LazyLock<StdMutex<HashMap<String, u32>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));
/// Per-session cache of a valid worktree check, so watcher re-lists skip `git worktree list`.
/// Cleared on reset or forget.
static VALIDITY_CACHE: LazyLock<StdMutex<HashMap<String, WorktreeValidity>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

fn normalize_path_key(relative_path: &str) -> String {
    relative_path.to_lowercase()
}

fn directory_flush_key(session_id: &str, relative_path: &str) -> String {
    format!("{session_id}\0{relative_path}")
}

/// Records a directory the renderer has listed, so watcher re-lists refresh it.
pub fn record_loaded_path(session_id: &str, relative_path: &str) {
    let mut loaded = LOADED_PATHS.lock().expect("loaded-paths mutex poisoned");
    loaded
        .entry(session_id.to_string())
        .or_default()
        .insert(normalize_path_key(relative_path), relative_path.to_string());
}

/// Renderer-relative directories loaded for a Session.
pub fn loaded_paths_for(session_id: &str) -> Vec<String> {
    LOADED_PATHS
        .lock()
        .expect("loaded-paths mutex poisoned")
        .get(session_id)
        .map(|m| m.values().cloned().collect())
        .unwrap_or_default()
}

/// True when the renderer has listed at least one directory for this Session.
pub fn has_loaded_paths(session_id: &str) -> bool {
    LOADED_PATHS
        .lock()
        .expect("loaded-paths mutex poisoned")
        .contains_key(session_id)
}

/// Only re-lists directories the renderer has already fetched, so build-output churn is ignored.
fn is_loaded(session_id: &str, relative_path: &str) -> bool {
    LOADED_PATHS
        .lock()
        .expect("loaded-paths mutex poisoned")
        .get(session_id)
        .is_some_and(|m| m.contains_key(&normalize_path_key(relative_path)))
}

/// Drops all File Explorer state for a Session.
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

/// True when a watcher is running for this Session.
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

/// Tells the renderer to re-check the tree after a lifecycle change.
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

/// Crate-visible so the git-changes watcher honours the same busy claim (#464).
pub(crate) fn is_session_busy(session_id: &str) -> bool {
    BUSY_SESSIONS
        .lock()
        .expect("busy mutex poisoned")
        .contains_key(session_id)
}

/// Number of busy claims on `session_id`. `ensure_watcher` needs the count, not a bool,
/// to tell its own claim apart from a lifecycle operation's.
fn busy_count(session_id: &str) -> u32 {
    BUSY_SESSIONS
        .lock()
        .expect("busy mutex poisoned")
        .get(session_id)
        .copied()
        .unwrap_or(0)
}

/// What the renderer is told when a lifecycle operation finishes: `Reset` re-checks the tree,
/// `Forgotten` means the session is gone.
pub enum WorktreeOperationOutcome {
    Reset,
    Forgotten,
}

/// Guard for a lifecycle operation. `finish` clears busy and resets or forgets. Dropping it
/// unfinished (an early error) still resets, since the watcher was already stopped.
#[must_use]
pub struct WorktreeOperationGuard {
    session_id: String,
    app_handle: Arc<StdMutex<Option<AppHandle>>>,
    finished: bool,
}

impl WorktreeOperationGuard {
    /// Clears busy, then resets or forgets the Session's File Explorer state.
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

/// Marks the session busy, then stops its watcher, before the worktree is touched. A running
/// watcher holds the root open and makes recreate fail with `EPERM`.
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

/// Worktree validity check. Only `Valid` is cached, so a repaired worktree is seen on Retry.
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

/// Captures the current watcher handle, so a caller can check it is still the same one after an await.
pub fn watcher_handle(session_id: &str) -> Option<DirectoryWatchHandle> {
    WATCHERS
        .lock()
        .expect("watchers mutex poisoned")
        .get(session_id)
        .map(|s| s.handle.clone())
}

/// True when the Session's current watcher is still `expected`.
pub fn watcher_matches(session_id: &str, expected: &DirectoryWatchHandle) -> bool {
    watcher_still_current(session_id, expected)
}

/// Checks the session still exists and is not archived. No registry means proceed.
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
    // Same guards as the renderer's refresh, checked before any I/O.
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
            // A vanished worktree stops the watcher and tells the renderer, so no dead root stays watched.
            stop_file_explorer_watcher(&session_id);
            notify_file_explorer_reset(&app_handle, &session_id);
        }
        Err(_) => {
            // Other re-list failures are swallowed; the next change or explicit list retries.
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

/// Starts a watcher unless one exists or the session is archived, busy, or missing its worktree.
/// Check and busy claim share one lock; a losing caller drops its own watcher, so none is orphaned.
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
        // Busy claim is taken under the same lock as the check, so a lifecycle op cannot slip in between.
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
    // A second busy claim means a lifecycle operation started meanwhile, so back off.
    if watchers.contains_key(session_id) || busy_count(session_id) > 1 {
        drop(watchers);
        handle.stop();
        return;
    }
    watchers.insert(session_id.to_string(), SessionWatchState { handle });
}

/// Re-lists the directories a fresh watcher should refresh, so changes made before it started show up.
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
