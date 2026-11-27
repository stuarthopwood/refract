// Split out of `sessions_lifecycle.rs` (#806): reclaim hook and `sessions.delete` cleanup.

use std::path::Path;

use crate::fs::remove_tree::remove_tree;
use crate::git::worktree_validity::comparable_path;
use crate::store::registry::Session;

/// Call point for future worktree/branch reclaim (#657/#658); a no-op today.
pub(super) fn on_worktree_released(_session_id: &str) {
    #[cfg(test)]
    WORKTREE_RELEASED_HOOK_CALLS.with(|calls| calls.set(calls.get() + 1));
}

// Thread-local, not a global atomic: each `#[tokio::test]` stays on one thread, so parallel
// tests cannot make a "never fires on failure" assertion flaky.
#[cfg(test)]
thread_local! {
    pub(super) static WORKTREE_RELEASED_HOOK_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// True when another Session uses the same `session_dir`; the Personal Agent's Sessions all share
/// the home folder's, so that folder outlives any one of them.
pub(crate) fn shares_session_dir(sessions: &[Session], session: &Session) -> bool {
    let Some(dir) = session.session_dir.as_deref() else {
        return false;
    };
    let key = comparable_path(dir);
    sessions.iter().any(|other| {
        other.id != session.id
            && other
                .session_dir
                .as_deref()
                .is_some_and(|other_dir| comparable_path(other_dir) == key)
    })
}

/// Removes a deleted Session's OMP log folder. `remove_tree` bounds it by `sessions_root`: it refuses
/// the root itself, anything outside it and links, so the registry's hand-editable `sessionDir`
/// cannot aim the delete elsewhere. A folder another Session still uses is left entirely alone,
/// since its Conversation files belong to that Session too. Best-effort: a failure leaves files
/// behind but never fails the delete.
pub(super) async fn delete_session_logs(session_dir: &str, shared: bool, sessions_root: &Path) {
    if shared {
        log::info!(
            "sessions.delete: left the session log folder {session_dir} in place, another Session uses it"
        );
        return;
    }
    if !tokio::fs::try_exists(session_dir).await.unwrap_or(false) {
        return;
    }
    if let Err(err) = remove_tree(Path::new(session_dir), sessions_root).await {
        log::warn!("sessions.delete: could not remove the session log folder {session_dir}: {err}");
    }
}

#[cfg(test)]
#[path = "sessions_delete_support.test.rs"]
mod tests;
