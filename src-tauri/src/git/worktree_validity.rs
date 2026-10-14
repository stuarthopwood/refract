// Issue #729 (folded into lane R2, #785): "a single `worktree_is_valid()` (registered with git
// AND has its own `.git` pointer, not merely `exists()`) used by agent start, open and the
// Explorer; an invalid worktree reports `worktree-missing` and the Recreate action warns that
// unpushed work is lost." Electron's `worktrees.ts` has no single function with this exact
// contract -- `SessionManager.ts`/`fileExplorer.ts` each ran their own ad hoc `fs.stat` check
// (the bug #729 describes: a folder that still exists but whose `.git` pointer was hand-deleted,
// or one git no longer has registered, both read as present). This is the corrected replacement,
// public so lane R7 (#790, File Explorer) reuses the exact same check rather than another ad hoc
// `fs.stat`.
//
// Simplification from the TS `canonicalPath` (an `fs.realpath`-based walk that resolves
// junctions/symlinks): path comparisons here are LEXICAL only (resolve `.`/`..`, lowercase,
// platform separator), the same simplification `store::registry`'s own `same_path`/
// `resolve_path_lexical` already makes for comparing a worktree path that may not exist yet. A
// worktree reached only through a janky separately-aliased junction is out of scope for this
// slice; every path this module compares is either a literal `git worktree list --porcelain`
// value or the registry's own `Session.worktreePath`, never user-supplied.

use std::path::{Path, PathBuf};

use super::git::git;

/// Case- and separator-insensitive comparison key for a filesystem path, without touching disk
/// (mirrors `store::registry`'s private `same_path`/`resolve_path_lexical` pair, duplicated here
/// rather than exported across the `git`/`store` module boundary for one small pure function).
pub(crate) fn comparable_path(p: &str) -> String {
    let normalized = super::git::normalize_git_path(p);
    let path = Path::new(&normalized);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_default()
            .join(path)
    };
    let mut out: Vec<std::ffi::OsString> = Vec::new();
    for component in resolved.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str().to_os_string()),
        }
    }
    let mut result = PathBuf::new();
    for part in out {
        result.push(part);
    }
    result.to_string_lossy().to_lowercase()
}

/// Parses `git worktree list --porcelain` output into each entry's own `worktree <path>` line
/// (the only line this module needs; branch/HEAD/locked lines are irrelevant here).
pub(crate) fn parse_porcelain_worktree_paths(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .map(str::to_string)
        .collect()
}

/// True when git itself still has `worktree_path` registered as one of `repo`'s worktrees.
pub(crate) async fn is_worktree_registered(repo: &Path, worktree_path: &Path) -> bool {
    let Ok(stdout) = git(repo, &["worktree", "list", "--porcelain"]).await else {
        return false;
    };
    let target = comparable_path(&worktree_path.to_string_lossy());
    parse_porcelain_worktree_paths(&stdout)
        .iter()
        .any(|p| comparable_path(p) == target)
}

/// Issue #729: valid means git still recognises `worktree_path` as a registered worktree of
/// `repo` AND the folder still has its own `.git` entry (a file for a linked worktree) -- not
/// merely `exists()`, which a hand-emptied folder (registered, but its `.git` pointer deleted)
/// or an orphaned leftover (folder present, git already lost track of it) both satisfy while
/// being unusable. Used by Session start/open and the File Explorer (lane R7) to report
/// `worktree-missing` instead of silently treating either state as a healthy worktree.
pub async fn worktree_is_valid(repo: &Path, worktree_path: &Path) -> bool {
    let has_git_entry = tokio::fs::symlink_metadata(worktree_path.join(".git"))
        .await
        .is_ok();
    if !has_git_entry {
        return false;
    }
    is_worktree_registered(repo, worktree_path).await
}
