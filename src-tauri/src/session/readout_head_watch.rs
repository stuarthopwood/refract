// Per-Session HEAD watch (#724): a branch switch outside a turn refreshes `branch` within about a second.
// Watches the directory: git renames `HEAD.lock` over HEAD, which drops a file watch.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use std::time::Duration;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};

use crate::fs::worktree_access::read_guard_bounded;
use crate::git::git::git_raw;

use super::agent::SessionAgent;
use super::readout::{compute_branch, current_readout_value, schedule_readout_update};

const DEBOUNCE_MS: u64 = 150;
const GIT_PATH_TIMEOUT: Duration = Duration::from_secs(3);

static WATCHERS: LazyLock<StdMutex<HashMap<String, RecommendedWatcher>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

async fn resolve_head_dir(session_id: &str, worktree_path: &str) -> Option<PathBuf> {
    let worktree = Path::new(worktree_path);
    let _guard = read_guard_bounded(session_id).await.ok()?;
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

/// Pushes the new branch on the last readout at once; the full recompute stores the rest later.
async fn push_branch_now(agent: &Arc<SessionAgent>, worktree_path: &str) {
    let branch = compute_branch(agent.session_id(), worktree_path).await;
    let mut readout = current_readout_value(agent).await;
    if readout.get("branch") == Some(&branch) || !agent.is_visible() {
        return;
    }
    readout["branch"] = branch;
    agent
        .events()
        .emit_readout_update(agent.session_id(), readout);
}

/// Starts or replaces the watch; an unreadable worktree leaves the Session unwatched.
pub(super) async fn start(agent: &SessionAgent, worktree_path: &str) {
    let session_id = agent.session_id().to_string();
    stop(&session_id);
    let Some(dir) = resolve_head_dir(&session_id, worktree_path).await else {
        return;
    };
    let weak = Arc::downgrade(&agent.arc());
    let worktree = worktree_path.to_string();
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
        let worktree = worktree.clone();
        runtime.spawn(async move {
            tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS)).await;
            armed.store(false, Ordering::SeqCst);
            if let Some(agent) = weak.upgrade() {
                push_branch_now(&agent, &worktree).await;
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
