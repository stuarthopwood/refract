// Watcher bookkeeping for the Git changes panel (spec 018 slice 1, issue #464): a MUCH SMALLER
// analogue of `fs::explorer_watch_state` -- that module's own header comment explains the full
// tree-diff/loaded-path/busy-session bookkeeping the File explorer panel needs to patch a SINGLE
// changed directory into an already-rendered tree without collapsing unrelated expanded
// branches. This panel has no tree to patch at all: its one refresh trigger from a worktree
// file-system change (FR-015b) is "something changed under this worktree, tell the renderer to
// refetch everything" -- the renderer always calls `gitChanges.list` again wholesale
// (`git-changes-store.ts`), never a per-directory patch. One `HashMap<String,
// DirectoryWatchHandle>` keyed by Session id is therefore enough; `fs::watch::watch_directory`
// (the plain primitive, also what `explorer_watch_state` itself calls) does every bit of actual
// watching/debouncing, and this module's own callback just emits `events::GIT_CHANGES_REFRESH`
// with no payload beyond the Session id (matching `FILE_EXPLORER_RESET`'s own minimal shape, not
// `FILE_EXPLORER_PATCH`'s full-payload one).
//
// Known simplification, accepted for this slice (research.md decision 6 scopes this module down
// deliberately): a burst touching several DIFFERENT directories at once (e.g. an agent's own
// `pnpm install`) fires one debounced refresh ping per distinct directory (`fs::watch.rs`'s own
// per-directory trailing-edge debounce, not a single global one) -- several near-simultaneous
// `gitChanges.list` calls rather than one coalesced call. The File explorer panel's own
// `FLUSH_SEMAPHORE`/per-Session debounce exists to bound PER-DIRECTORY LISTING work, a cost this
// panel's single wholesale refetch does not have; de-duplicating the PING itself (if the ping
// volume in practice turns out to matter) is a renderer-side `git-changes-store.ts` concern, not
// this watcher's.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

use serde_json::json;
use tauri::AppHandle;

use crate::fs::watch::{watch_directory_without_liveness_requeue, DirectoryWatchHandle};

static WATCHERS: LazyLock<StdMutex<HashMap<String, DirectoryWatchHandle>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

/// Idempotent: a no-op when nothing is watching this Session (FR-016: the panel calls this on
/// unmount/Session-blur, matching `fileExplorer.stopWatching`'s own lifecycle shape).
pub fn stop_watcher(session_id: &str) {
    WATCHERS
        .lock()
        .expect("git changes watchers mutex poisoned")
        .remove(session_id);
}

fn notify_refresh(app_handle: &Arc<StdMutex<Option<AppHandle>>>, session_id: &str) {
    let handle = app_handle
        .lock()
        .expect("app handle mutex poisoned")
        .clone();
    if let Some(h) = handle {
        crate::events::emit(
            &h,
            crate::events::GIT_CHANGES_REFRESH,
            json!({ "sessionId": session_id }),
        );
    }
}

/// Starts a watcher for `session_id` if one is not already running (idempotent, mirrors
/// `explorer_watch_state::ensure_watcher`'s own early-return shape, minus the busy-Session/
/// worktree-validity bookkeeping that module needs and this one does not -- a closed panel
/// simply never calls this at all, FR-016, so there is no "watcher outliving its own panel"
/// case to guard against here the way a Session-lifecycle operation can race the File explorer
/// panel's watcher). On a fatal watch error (the worktree root itself deleted/moved,
/// `fs::watch.rs`'s own `on_fatal`), the watcher is dropped so the next `ensureWatching` call
/// (the panel re-mounting, or simply being re-opened) retries rather than staying silently
/// un-watched forever -- `gitChanges.list`/the mutating actions all still work regardless in the
/// meantime; only the live auto-refresh (FR-015b) is lost until a fresh watcher starts.
///
/// Gate round 2 item 9 (#464): `archived` returns immediately, before even the busy check below
/// -- mirrors `ipc::file_explorer::file_explorer_ensure_watching`'s own convention (via
/// `explorer_watch_state::ensure_watcher`'s own `archived` early return), not
/// `file_explorer_list_directory`'s DIFFERENT convention of an explicit `session-archived`
/// error: `ensureWatching` for an archived Session is a normal, expected no-op (an archived
/// Session's own panel can still be open read-only), never an error condition.
pub fn ensure_watcher(
    app_handle: Arc<StdMutex<Option<AppHandle>>>,
    session_id: &str,
    worktree_path: &Path,
    archived: bool,
) {
    if archived {
        return;
    }
    // Gate round 1 item 1 (#464): reuses `explorer_watch_state`'s own busy-session claim --
    // `ipc::sessions_lifecycle`'s `.archive`/`.delete`/`.recreateWorktree` hold it (via
    // `begin_worktree_operation`) for the whole duration of a worktree mutation, after already
    // stopping any watcher this module itself was running. Refusing here closes the race a
    // still-mounted panel's own `ensureWatching` call would otherwise win: without this check it
    // could restart a watcher mid-operation, immediately after the lifecycle handler stopped it.
    if crate::fs::explorer_watch_state::is_session_busy(session_id) {
        return;
    }
    {
        let watchers = WATCHERS
            .lock()
            .expect("git changes watchers mutex poisoned");
        if watchers.contains_key(session_id) {
            return;
        }
    }
    let changed_app_handle = app_handle.clone();
    let changed_session_id = session_id.to_string();
    let fatal_session_id = session_id.to_string();
    let handle = watch_directory_without_liveness_requeue(
        worktree_path,
        move |_relative_directory| {
            notify_refresh(&changed_app_handle, &changed_session_id);
        },
        move || {
            WATCHERS
                .lock()
                .expect("git changes watchers mutex poisoned")
                .remove(&fatal_session_id);
        },
    );
    if let Some(handle) = handle {
        // Gate round 2 item 8 (#464): the busy check above and this insert are two separate
        // critical sections with real async-adjacent work in between (the call just above:
        // spawns a `notify` watcher and a background thread) -- a worktree operation
        // (`begin_worktree_operation`) can become busy for this exact Session in that window,
        // after the first check already passed. Re-checking immediately before the insert
        // shrinks that window to as small as this module alone can make it; true atomicity
        // across both this module's own `WATCHERS` lock and `explorer_watch_state`'s own
        // separate busy-claim lock would need a shared lock between the two modules, out of
        // scope this round. If the recheck finds it busy, the just-created handle is stopped
        // (`DirectoryWatchHandle::stop`'s own doc comment: "safe to call more than once") and
        // discarded rather than inserted, so the panel's own next `ensureWatching` call (after
        // the operation finishes and the explorer-reset event fires) retries cleanly instead of
        // this watcher silently lingering mid-operation.
        if crate::fs::explorer_watch_state::is_session_busy(session_id) {
            handle.stop();
            return;
        }
        WATCHERS
            .lock()
            .expect("git changes watchers mutex poisoned")
            .insert(session_id.to_string(), handle);
    }
}
