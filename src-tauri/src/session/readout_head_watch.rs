// Issue #724 (spec 019 FR-003): a per-Session watch on the directory holding the worktree's own
// HEAD file, so a branch switch made outside a turn (a terminal, an IDE) refreshes the readout's
// live `branch` within about a second. `readout::on_launch` starts it, `readout::on_exit` stops it.
//
// The HEAD path comes from `git rev-parse --git-path HEAD`, never `<worktree>/.git/HEAD`: in a
// linked worktree `.git` is a pointer file and HEAD lives under `<repo>/.git/worktrees/<name>/`.
// The containing directory is watched (non-recursive) because git replaces HEAD by writing
// `HEAD.lock` and renaming it, which can drop a watch placed on the file itself. Only events whose
// file name is exactly `HEAD` count (`ORIG_HEAD`, `FETCH_HEAD`, the index and so on are ignored).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use std::time::Duration;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};

use crate::git::git::git_raw;

use super::agent::SessionAgent;
use super::readout::schedule_readout_update;

const DEBOUNCE_MS: u64 = 300;
const GIT_PATH_TIMEOUT: Duration = Duration::from_secs(3);

static WATCHERS: LazyLock<StdMutex<HashMap<String, RecommendedWatcher>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

async fn resolve_head_dir(worktree_path: &str) -> Option<PathBuf> {
    let worktree = Path::new(worktree_path);
    let out = git_raw(
        worktree,
        &["rev-parse", "--git-path", "HEAD"],
        Some(GIT_PATH_TIMEOUT),
    )
    .await;
    let raw = out.stdout.trim();
    if out.code != 0 || raw.is_empty() {
        return None;
    }
    let head = PathBuf::from(raw);
    let head = if head.is_absolute() {
        head
    } else {
        worktree.join(head)
    };
    head.parent().map(Path::to_path_buf)
}

/// Starts (or replaces) the HEAD watch for `agent`'s Session. A worktree git cannot read, or a
/// directory the OS will not watch, leaves the Session unwatched; turn and tool-call refreshes
/// still apply.
pub(super) async fn start(agent: &SessionAgent, worktree_path: &str) {
    let session_id = agent.session_id().to_string();
    stop(&session_id);
    let Some(dir) = resolve_head_dir(worktree_path).await else {
        return;
    };
    let weak = Arc::downgrade(&agent.arc());
    let armed = Arc::new(AtomicBool::new(false));
    let runtime = tokio::runtime::Handle::current();
    let watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        let Ok(event) = res else { return };
        if !event
            .paths
            .iter()
            .any(|p| p.file_name().is_some_and(|n| n == "HEAD"))
        {
            return;
        }
        // Trailing-edge debounce armed by the first event of a burst (never reset by later ones).
        if armed.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak = weak.clone();
        let armed = armed.clone();
        runtime.spawn(async move {
            tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS)).await;
            armed.store(false, Ordering::SeqCst);
            if let Some(agent) = weak.upgrade() {
                schedule_readout_update(&agent).await;
            }
        });
    });
    let Ok(mut watcher) = watcher else { return };
    if watcher.watch(&dir, RecursiveMode::NonRecursive).is_err() {
        return;
    }
    if let Ok(mut map) = WATCHERS.lock() {
        map.insert(session_id, watcher);
    }
}

/// Drops the Session's HEAD watch, if any. Safe to call more than once.
pub(super) fn stop(session_id: &str) {
    if let Ok(mut map) = WATCHERS.lock() {
        map.remove(session_id);
    }
}
