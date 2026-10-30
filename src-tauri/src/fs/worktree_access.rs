// Per-Session read/write lock so a delete waits for in-flight worktree readers (git children
// with the worktree as cwd) to finish before removing anything.
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
    // Drops entries no caller still holds, so the map does not grow forever.
    locks.retain(|_, lock| Arc::strong_count(lock) > 1);
    locks
        .entry(session_id.to_string())
        .or_insert_with(|| Arc::new(RwLock::new(())))
        .clone()
}

/// Read guard held by a worktree reader for its whole duration.
pub async fn read_guard(session_id: &str) -> OwnedRwLockReadGuard<()> {
    lock_for(session_id).read_owned().await
}

/// Write guard taken before any removal; waits for all readers to release.
pub async fn write_guard(session_id: &str) -> OwnedRwLockWriteGuard<()> {
    lock_for(session_id).write_owned().await
}

/// Bounds the writer wait so a hung reader cannot block delete forever (#1055).
pub const WRITE_GUARD_TIMEOUT: Duration = Duration::from_secs(20);

/// Bounds reader wait and git work; kept below `WRITE_GUARD_TIMEOUT` (#1055).
pub const READER_TIMEOUT: Duration = Duration::from_secs(15);

/// Read-side refusal text; no Retry button exists here, so it must not mention one.
pub const STILL_CHECKING_READ_MESSAGE: &str =
    "Refract is still busy with this folder, so it could not check what Delete would lose. Close this dialog and open it again in a moment.";

/// Write-side refusal text shown when a Delete cannot proceed yet.
pub const STILL_CHECKING_MESSAGE: &str =
    "Refract is still checking this folder, so nothing was deleted. Choose Retry in a moment.";

/// Bounded `write_guard`; refuses as busy with nothing touched (#1163).
pub async fn write_guard_bounded(session_id: &str) -> Result<OwnedRwLockWriteGuard<()>, GitError> {
    tokio::time::timeout(WRITE_GUARD_TIMEOUT, write_guard(session_id))
        .await
        .map_err(|_| GitError::new(GitErrorCode::WorktreeBusy, STILL_CHECKING_MESSAGE))
}

/// Bounded cancel of the leftover walk, so a stuck walk cannot hang Delete (#1163).
pub async fn cancel_walk_bounded(session_id: &str) -> Result<(), GitError> {
    tokio::time::timeout(
        WRITE_GUARD_TIMEOUT,
        crate::fs::leftover_summary::cancel_and_wait(session_id),
    )
    .await
    .map_err(|_| GitError::new(GitErrorCode::WorktreeBusy, STILL_CHECKING_MESSAGE))
}

/// Bounded `read_guard`; a queued writer would otherwise stall new readers (#1163).
pub async fn read_guard_bounded(session_id: &str) -> Result<OwnedRwLockReadGuard<()>, GitError> {
    tokio::time::timeout(READER_TIMEOUT, read_guard(session_id))
        .await
        .map_err(|_| GitError::new(GitErrorCode::WorktreeBusy, STILL_CHECKING_READ_MESSAGE))
}
