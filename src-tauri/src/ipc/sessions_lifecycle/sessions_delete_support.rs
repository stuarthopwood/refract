// Non-lifecycle support helpers split out of the parent `sessions_lifecycle.rs` (#806 "No god
// files", issue #891 gate round 1 margin): the worktree/branch reclaim hook and the two
// `sessions.delete`-only helpers (Conversation-file cleanup and its own path-containment
// check) never decide a Session's own lifecycle transition themselves -- `sessions_delete`
// calls them only after the worktree itself is already gone -- so they split cleanly out the
// same way `diag.rs` already split `sessions.diffStat`/`sessions.revealWorktree` out. `pub(super)`
// throughout: used only by the parent, never a second direct entry point in `ipc/mod.rs`.

use std::path::Path;

use crate::git::worktree_validity::comparable_path;

/// Issues #657/#658 (gate round 2: a reviewer found this bullet in #785 asks only for a call
/// point plus a test, never the 5-slice reclaim POLICY those two issues themselves scope --
/// this hook is exactly that call point, nothing more): the single place future worktree/branch
/// reclaim logic for a Session whose worktree is no longer needed (archived, or deleted)
/// attaches to, so a later lane implementing #657's slice 1 or #658's reap step never has to
/// rediscover where `sessions.archive`/`sessions.delete` finish releasing a worktree. A no-op
/// today -- the decision on WHETHER/WHEN to reclaim stays with #657/#658, not this lane.
pub(super) fn on_worktree_released(_session_id: &str) {
    #[cfg(test)]
    WORKTREE_RELEASED_HOOK_CALLS.with(|calls| calls.set(calls.get() + 1));
}

// Thread-local, not a global atomic (gate round 2): `#[tokio::test]`'s default current-thread
// runtime keeps one whole test's execution on a single OS thread from start to finish, and the
// std test harness never runs two different tests concurrently on that SAME thread -- so a
// thread-local counter isolates each test's own "did the hook fire" observation from every
// OTHER test running in parallel on a different thread, which a single process-wide atomic
// could not (a concurrently running, unrelated archive/delete call firing the hook would have
// made a "never fires on failure" assertion flaky).
#[cfg(test)]
thread_local! {
    pub(super) static WORKTREE_RELEASED_HOOK_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Security: a Session's `session_dir` is learned from OMP's own `get_state`, but the registry
/// is just a JSON file -- a corrupted or hand-edited one must never make `sessions.delete`
/// remove an arbitrary path. Only a true descendant of the real OMP sessions root (never the
/// root itself) is ever touched. Mirrors `sessions.ts`'s own `isStrictDescendantOfOmpSessions`;
/// `dirs::home_dir()` is the same home-directory resolution `omp/process.rs` already uses for
/// `~/.omp/logs`, and `comparable_path` is the same lexical-resolve-plus-lowercase comparison
/// key `git::worktree_validity`/`store::registry` already use for a path that may not (yet)
/// exist on disk.
pub(super) fn is_strict_descendant_of_omp_sessions(dir: &str) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let sessions_root = comparable_path(
        &home
            .join(".omp")
            .join("agent")
            .join("sessions")
            .to_string_lossy(),
    );
    let resolved = comparable_path(dir);
    resolved != sessions_root
        && resolved.starts_with(&format!("{sessions_root}{}", std::path::MAIN_SEPARATOR))
}

/// Deletes only this Session's own Conversation files (`*.jsonl`) and their sibling same-stem
/// directories (subagent transcripts, data-model.md), then removes `session_dir` itself only
/// once it is empty -- never a wholesale recursive remove, which could take unrelated sibling
/// Conversations or (if `session_dir` were ever wrong) far more than that. Best-effort
/// throughout (mirrors `sessions.ts`'s own `deleteSessionConversations`): every removal failure
/// is swallowed, since a Session that could not fully clean up its own transcript files still
/// must finish being deleted from the registry.
pub(super) async fn delete_session_conversations(session_dir: &str) {
    let dir = Path::new(session_dir);
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(_) => return,
    };
    let mut names = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        names.push(entry.file_name());
    }
    for name in names {
        let name = name.to_string_lossy().into_owned();
        if !name.to_lowercase().ends_with(".jsonl") {
            continue;
        }
        let file_path = dir.join(&name);
        let sibling_dir = dir.join(&name[..name.len() - ".jsonl".len()]);
        let _ = tokio::fs::remove_file(&file_path).await;
        let _ = tokio::fs::remove_dir_all(&sibling_dir).await;
    }
    if let Ok(mut remaining) = tokio::fs::read_dir(dir).await {
        if matches!(remaining.next_entry().await, Ok(None)) {
            let _ = tokio::fs::remove_dir(dir).await;
        }
    }
}
