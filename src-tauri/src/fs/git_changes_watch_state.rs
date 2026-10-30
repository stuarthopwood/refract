// Git changes panel watcher: any change under the worktree emits one refresh ping per Session,
// and the renderer refetches the whole list. A burst across several directories sends several pings.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

use serde_json::json;
use tauri::AppHandle;

use crate::fs::watch::{watch_directory_without_liveness_requeue, DirectoryWatchHandle};

static WATCHERS: LazyLock<StdMutex<HashMap<String, DirectoryWatchHandle>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

/// Idempotent: a no-op when nothing watches this Session.
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

/// Starts a watcher for `session_id` unless one already runs. An archived Session is a no-op,
/// not an error. A fatal watch error drops the watcher so the next `ensureWatching` retries.
pub fn ensure_watcher(
    app_handle: Arc<StdMutex<Option<AppHandle>>>,
    session_id: &str,
    worktree_path: &Path,
    archived: bool,
) {
    if archived {
        return;
    }
    // Skips a Session mid-worktree-mutation, so a panel cannot restart a watcher the lifecycle handler just stopped.
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
        // Rechecks busy after the watcher spawns, since a worktree operation can start in that gap.
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
