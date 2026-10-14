// Port of `src/main/ipc/fileExplorer.ts`'s own `resolveListTarget`/`listDirectoryEntries`/
// `sortEntries`/`classifySymlinkEntry`/`mapReaddirError` (lane R7, issue #790): resolves, reads,
// caps, classifies, and sorts one directory's listing -- shared by `ipc::file_explorer`'s own
// `listDirectory` handler and its watcher's re-list-on-change path, so a live patch is never
// produced by a second, drifting copy of this containment/capping/classification logic.
//
// Folds in issue #729 (`worktree_is_valid`, lane R2 #785): a root listing (`relative_path ==
// ""`) first proves the worktree is actually REGISTERED with git and has its own `.git` pointer,
// not merely that the folder exists -- an empty, orphaned folder (the bug #729 describes) is
// `worktree-missing`, never a false "this folder is empty". The validity check itself is cached
// per Session (`fs::explorer_watch_state::cached_worktree_validity`) so a watcher-triggered
// re-list of the root never spawns a fresh `git worktree list` on every debounced flush (perf
// finding, gate round 1).

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::fs::explorer_watch_state::cached_worktree_validity;
use crate::fs::paths::contains_git_segment;
use crate::fs::resolve::{
    canonicalize_root, resolve_in_worktree, resolve_in_worktree_with_root, resolve_reason_message,
    ResolveReason,
};
use crate::git::worktree_validity::WorktreeValidity;

/// Same shape as `src/shared/model.ts`'s `FileTreeEntryKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileTreeEntryKind {
    File,
    Folder,
    CannotAccess,
}

/// Same shape as `src/shared/model.ts`'s `FileTreeNode`. `git_status` is merged in by the
/// renderer from `fileExplorer.getStatus`'s own full-worktree map (never sent by this listing
/// itself), so always `None` here.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeNode {
    pub path: String,
    pub name: String,
    pub kind: FileTreeEntryKind,
}

pub struct ListDirectoryOk {
    pub entries: Vec<FileTreeNode>,
    pub truncated: usize,
}

#[derive(Debug)]
pub enum ListDirectoryError {
    WorktreeMissing,
    FileMissing(String),
    OutsideWorktree,
    InvalidArgument(String),
}

pub type ListDirectoryResult = Result<ListDirectoryOk, ListDirectoryError>;

pub enum ResolveTargetOk {
    Root(PathBuf),
    Path(PathBuf),
}

impl ResolveTargetOk {
    pub fn real_path(&self) -> &Path {
        match self {
            ResolveTargetOk::Root(p) | ResolveTargetOk::Path(p) => p,
        }
    }
}

/// Resolves, for the `relative_path` LISTING target (never a plain file-containment proof --
/// `''` is this function's own special case for the worktree root itself, mirrors `fileExplorer.
/// ts`'s own `resolveListTarget`): proves the worktree is a VALID one (issue #729, cached per
/// `session_id`) for a root listing, rejects `.git` as a requested path (as-typed AND
/// post-realpath, FR-007), and defers to `resolve_in_worktree` unchanged for every other value.
pub async fn resolve_list_target(
    session_id: &str,
    repo_path: Option<&Path>,
    worktree_root: &Path,
    relative_path: &str,
) -> Result<ResolveTargetOk, ResolveReason> {
    if relative_path.is_empty() {
        if let Some(repo_path) = repo_path {
            if cached_worktree_validity(session_id, repo_path, worktree_root).await
                == WorktreeValidity::Invalid
            {
                return Err(ResolveReason::WorktreeMissing);
            }
        }
        let root_real = canonicalize_root(worktree_root).await?;
        return Ok(ResolveTargetOk::Root(root_real));
    }

    if contains_git_segment(relative_path) {
        return Err(ResolveReason::OutsideWorktree);
    }
    let resolved = resolve_in_worktree(worktree_root, relative_path).await?;
    let root_real = canonicalize_root(worktree_root)
        .await
        .unwrap_or_else(|_| worktree_root.to_path_buf());
    let rel_from_root = resolved
        .strip_prefix(&root_real)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    if contains_git_segment(&rel_from_root) {
        return Err(ResolveReason::OutsideWorktree);
    }
    Ok(ResolveTargetOk::Path(resolved))
}

/// Spec.md Edge Cases ("a huge repository"): caps how many entries ONE `list_directory_entries`
/// call ever classifies/returns for a single directory -- enforced here in the backend, not only
/// by the renderer's own virtualisation, so a pathologically huge directory can never force
/// unbounded per-entry symlink-classification work.
const MAX_ENTRIES_PER_DIRECTORY: usize = 1000;

/// Bounds how many symlink/junction entries are classified at once (never one `readlink`/`stat`
/// round trip after another for a folder full of them, e.g. a pnpm `node_modules`).
const SYMLINK_CLASSIFY_CONCURRENCY: usize = 8;

fn sort_entries(entries: &mut [FileTreeNode]) {
    entries.sort_by(|a, b| {
        let rank = |n: &FileTreeNode| {
            if n.kind == FileTreeEntryKind::Folder {
                0
            } else {
                1
            }
        };
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

/// Classifies ONE symlink/junction dirent's `kind` by reusing the SAME hardened resolver every
/// other path in this codebase goes through: a target that escapes, is UNC/device-shaped, or
/// sits behind a chain of links into any of those (or lands under `.git`), resolves to
/// `cannot-access` without ever being followed by anything else. Takes the worktree root ALREADY
/// canonicalized once by the caller (`resolved_root`/`unresolved_root`), rather than re-running
/// `dunce::canonicalize` on a tokio worker for every one of up to 1000 entries (perf finding,
/// gate round 1): `resolve_in_worktree_with_root` skips exactly that redundant step.
async fn classify_symlink_entry(
    resolved_root: &Path,
    unresolved_root: &Path,
    entry_abs_path: &Path,
) -> FileTreeEntryKind {
    let resolved = match resolve_in_worktree_with_root(
        resolved_root,
        unresolved_root,
        &entry_abs_path.to_string_lossy(),
    )
    .await
    {
        Ok(p) => p,
        Err(_) => return FileTreeEntryKind::CannotAccess,
    };
    let rel = resolved
        .strip_prefix(resolved_root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    if contains_git_segment(&rel) {
        return FileTreeEntryKind::CannotAccess;
    }
    match tokio::fs::metadata(&resolved).await {
        Ok(m) if m.is_dir() => FileTreeEntryKind::Folder,
        Ok(_) => FileTreeEntryKind::File,
        Err(_) => FileTreeEntryKind::File,
    }
}

fn map_readdir_error(err: &std::io::Error) -> ListDirectoryError {
    match err.kind() {
        std::io::ErrorKind::NotFound => {
            ListDirectoryError::FileMissing("That folder no longer exists".to_string())
        }
        std::io::ErrorKind::NotADirectory => {
            ListDirectoryError::InvalidArgument("That is not a folder".to_string())
        }
        std::io::ErrorKind::PermissionDenied => ListDirectoryError::InvalidArgument(
            "You do not have permission to open that folder".to_string(),
        ),
        _ => ListDirectoryError::InvalidArgument("Could not read that folder".to_string()),
    }
}

/// Resolves, reads, caps, classifies, and sorts one directory's listing -- the one hardened
/// implementation shared by the `listDirectory` IPC handler and the file watcher's own
/// re-list-on-change path. `session_id` keys the issue #729 validity cache (root listings only).
pub async fn list_directory_entries(
    session_id: &str,
    repo_path: Option<&Path>,
    worktree_path: &Path,
    relative_path: &str,
) -> ListDirectoryResult {
    let resolved = resolve_list_target(session_id, repo_path, worktree_path, relative_path)
        .await
        .map_err(resolve_reason_to_error)?;
    let real_path = resolved.real_path().to_path_buf();

    let root_real_path = canonicalize_root(worktree_path)
        .await
        .unwrap_or_else(|_| real_path.clone());
    let unresolved_root = worktree_path.to_path_buf();

    let mut read_dir = match tokio::fs::read_dir(&real_path).await {
        Ok(rd) => rd,
        Err(err) => return Err(map_readdir_error(&err)),
    };
    let mut dirents: Vec<(String, bool, bool)> = Vec::new(); // (name, is_dir, is_symlink)
    loop {
        let entry = match read_dir.next_entry().await {
            Ok(Some(e)) => e,
            Ok(None) => break,
            Err(err) => return Err(map_readdir_error(&err)),
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.eq_ignore_ascii_case(".git") {
            continue;
        }
        let file_type = match entry.file_type().await {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        dirents.push((name, file_type.is_dir(), file_type.is_symlink()));
    }

    dirents.sort_by_key(|(name, _, _)| name.to_lowercase());
    let truncated = dirents.len().saturating_sub(MAX_ENTRIES_PER_DIRECTORY);
    if truncated > 0 {
        dirents.truncate(MAX_ENTRIES_PER_DIRECTORY);
    }

    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(SYMLINK_CLASSIFY_CONCURRENCY));
    let mut set = tokio::task::JoinSet::new();
    for (idx, (name, is_dir, is_symlink)) in dirents.iter().enumerate() {
        let permit_sem = semaphore.clone();
        let root_real_path = root_real_path.clone();
        let unresolved_root = unresolved_root.clone();
        let entry_abs = real_path.join(name);
        let is_dir = *is_dir;
        let is_symlink = *is_symlink;
        set.spawn(async move {
            let _permit = permit_sem
                .acquire_owned()
                .await
                .expect("semaphore never closes");
            let kind = if is_symlink {
                classify_symlink_entry(&root_real_path, &unresolved_root, &entry_abs).await
            } else if is_dir {
                FileTreeEntryKind::Folder
            } else {
                FileTreeEntryKind::File
            };
            (idx, kind)
        });
    }
    let mut kinds_slots: Vec<Option<FileTreeEntryKind>> = vec![None; dirents.len()];
    while let Some(res) = set.join_next().await {
        let (idx, kind) = res.expect("classify task panicked");
        kinds_slots[idx] = Some(kind);
    }
    let kinds: Vec<FileTreeEntryKind> = kinds_slots
        .into_iter()
        .map(|k| k.expect("every index was spawned exactly once"))
        .collect();

    let mut entries: Vec<FileTreeNode> = dirents
        .into_iter()
        .zip(kinds)
        .map(|((name, _, _), kind)| FileTreeNode {
            path: if relative_path.is_empty() {
                name.clone()
            } else {
                format!("{relative_path}/{name}")
            },
            name,
            kind,
        })
        .collect();
    sort_entries(&mut entries);

    Ok(ListDirectoryOk { entries, truncated })
}

fn resolve_reason_to_error(reason: ResolveReason) -> ListDirectoryError {
    match reason {
        ResolveReason::WorktreeMissing => ListDirectoryError::WorktreeMissing,
        ResolveReason::FileMissing => {
            ListDirectoryError::FileMissing(resolve_reason_message(reason, "folder"))
        }
        ResolveReason::OutsideWorktree => ListDirectoryError::OutsideWorktree,
    }
}

#[cfg(test)]
#[path = "list_directory_tests.rs"]
mod tests;
