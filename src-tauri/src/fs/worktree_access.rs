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
use std::time::Duration;

use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

use crate::git::git::{GitError, GitErrorCode};

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

/// Issue #1055: `sessions.delete`'s own write-guard wait is bounded. A reader that never
/// finishes (a hung git call: fsmonitor, antivirus, a network drive) would otherwise leave the
/// dialog on "Deleting…" forever, and the fair `RwLock` would queue every later reader behind
/// this writer too. Longer than `READER_TIMEOUT` so a bounded `deleteCheck` gives up first.
pub const WRITE_GUARD_TIMEOUT: Duration = Duration::from_secs(20);

/// Issue #1055: the most a `sessions.deleteCheck` may wait to acquire its read guard, and (in
/// `delete_check_for_session`) the most its git work may then run: each stage is bounded.
pub const READER_TIMEOUT: Duration = Duration::from_secs(15);

/// The `deleteCheck` refusal has no Retry button (the dialog shows it as a plain error), so it
/// must not tell the user to press one.
pub const STILL_CHECKING_READ_MESSAGE: &str =
    "Refract is still busy with this folder, so it could not check what Delete would lose. Close this dialog and open it again in a moment.";

pub const STILL_CHECKING_MESSAGE: &str =
    "Refract is still checking this folder, so nothing was deleted. Choose Retry in a moment.";

/// `write_guard` with `WRITE_GUARD_TIMEOUT`: an honest refusal (nothing touched yet, Retry
/// works) instead of an unbounded wait. Issue #1163: `WorktreeBusy`, not `WorktreeHeld`.
pub async fn write_guard_bounded(session_id: &str) -> Result<OwnedRwLockWriteGuard<()>, GitError> {
    tokio::time::timeout(WRITE_GUARD_TIMEOUT, write_guard(session_id))
        .await
        .map_err(|_| GitError::new(GitErrorCode::WorktreeBusy, STILL_CHECKING_MESSAGE))
}

/// Issue #1163: `leftover_summary::cancel_and_wait` with `WRITE_GUARD_TIMEOUT`, so a walk that
/// ignores its cancel flag yields the same honest refusal instead of hanging Delete.
pub async fn cancel_walk_bounded(session_id: &str) -> Result<(), GitError> {
    tokio::time::timeout(
        WRITE_GUARD_TIMEOUT,
        crate::fs::leftover_summary::cancel_and_wait(session_id),
    )
    .await
    .map_err(|_| GitError::new(GitErrorCode::WorktreeBusy, STILL_CHECKING_MESSAGE))
}

/// Issue #1163: `read_guard` with `READER_TIMEOUT`. A pending writer (a Delete waiting on a
/// hung reader) makes the fair `RwLock` queue new readers behind it, so the read-guard wait
/// must be bounded too, with the same honest "still checking" refusal.
pub async fn read_guard_bounded(session_id: &str) -> Result<OwnedRwLockReadGuard<()>, GitError> {
    tokio::time::timeout(READER_TIMEOUT, read_guard(session_id))
        .await
        .map_err(|_| GitError::new(GitErrorCode::WorktreeBusy, STILL_CHECKING_READ_MESSAGE))
}
