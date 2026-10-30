// Split out of `sessions_lifecycle.rs` (#806): reclaim hook and `sessions.delete` cleanup.

use std::path::Path;

use crate::git::worktree_validity::comparable_path;

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

/// Security: the registry is a hand-editable JSON file, so only a strict descendant of the real
/// OMP sessions root (never the root itself) may be removed by `sessions.delete`.
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

/// Deletes only this Session's Conversation files (`*.jsonl`) and same-stem directories, then
/// `session_dir` if empty; never a recursive remove. Best-effort: failures are swallowed.
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
