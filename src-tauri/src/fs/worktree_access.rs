// Issue #891 gate round 3 (H1, Main's own root-cause finding from app.log): the "transient
// sharing violation" scenarios (c)/(d) hit live was NEVER an external antivirus/indexer race --
// it was Refract's OWN background `sessions.deleteCheck` refresh (P4, `DeleteDialog.tsx`'s own
// post-refusal re-check), which spawns about five git child processes with `current_dir` set
// to the worktree (`worktree_delete_check.rs::delete_check_for_session`). M4 deliberately keeps
// Retry clickable while that refresh runs in the background, and `sessions.delete` only ever
// cancelled and awaited the leftover-summary walk before its holder checks, never this refresh
// -- so a Retry click could start removing the worktree while a STALE `deleteCheck` call from
// the PREVIOUS attempt still had git children running with their own cwd inside it.
//
// Fix: a per-Session `tokio::sync::RwLock<()>`. Every Refract-owned READER of a worktree
// (`sessions.deleteCheck`, the leftover-summary walk) holds a READ guard for its whole
// duration; `sessions.delete` acquires the WRITE guard before ANY holder check, which blocks
// until every outstanding reader has finished and released. No forced process kill is needed:
// `deleteCheck`'s own git children are plain async awaits (no `spawn_blocking` involved), so
// simply waiting them out is correct and race-free -- the leftover walk's own `cancel_and_wait`
// (called first, unchanged) asks it to finish sooner, shortening the write-guard wait, but does
// not need to kill anything either (its own `spawn_blocking` work cannot be hard-aborted, which
// is exactly why it already uses a cooperative cancel flag rather than a kill).
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

static LOCKS: LazyLock<Mutex<HashMap<String, Arc<RwLock<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn lock_for(session_id: &str) -> Arc<RwLock<()>> {
    let mut locks = LOCKS
        .lock()
        .expect("worktree access lock registry poisoned");
    // Opportunistic cleanup: an entry nobody else holds a clone of (only this map's own `Arc`)
    // is safe to drop, so this map never accumulates one lock per Session ever created over a
    // long-running app.
    locks.retain(|_, lock| Arc::strong_count(lock) > 1);
    locks
        .entry(session_id.to_string())
        .or_insert_with(|| Arc::new(RwLock::new(())))
        .clone()
}

/// Held by a Refract-owned READER of this Session's worktree (`sessions.deleteCheck`, the
/// leftover-summary walk) for its whole duration -- acquired as the very first thing each does,
/// before any filesystem or git access.
pub async fn read_guard(session_id: &str) -> OwnedRwLockReadGuard<()> {
    lock_for(session_id).read_owned().await
}

/// Held by `sessions.delete` before any holder check or removal -- blocks until every
/// outstanding reader above has released its own read guard.
pub async fn write_guard(session_id: &str) -> OwnedRwLockWriteGuard<()> {
    lock_for(session_id).write_owned().await
}
