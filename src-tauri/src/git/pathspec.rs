// Pathspec containment check shared by `changes_status.rs` and `changes_diff.rs`.

use std::path::{Path, PathBuf};

use crate::fs::resolve::is_unsafe_token;

use super::git::{GitError, GitErrorCode};

/// Refuses an unsafe pathspec before it reaches a `git` argv; lexical only, no disk access.
// Lexical (not canonicalize): the path may not exist yet (deleted-but-staged, or being restored).
// A leading `-` is option injection and `..` is traversal; untracked reads add a symlink check.
pub(super) fn validate_pathspec(worktree_path: &Path, path: &str) -> Result<(), GitError> {
    let refuse = || {
        GitError::new(
            GitErrorCode::OutsideWorktree,
            format!("refused unsafe path: {path}"),
        )
    };
    if path.is_empty()
        || path.starts_with('-')
        || path.starts_with('/')
        || path.starts_with('\\')
        || is_unsafe_token(path)
        || Path::new(path).is_absolute()
        || path.split(['/', '\\']).any(|segment| segment == "..")
    {
        return Err(refuse());
    }
    let joined: PathBuf = worktree_path.join(path).components().collect();
    let root: PathBuf = worktree_path.components().collect();
    if joined == root || !joined.starts_with(&root) {
        return Err(refuse());
    }
    Ok(())
}
