// Lists one directory, shared with the watcher's re-list so live patches match the listing.
// Root listings check worktree validity (#729), cached per Session so flushes do not spawn `git`.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::fs::explorer_watch_state::cached_worktree_validity;
use crate::fs::paths::contains_git_segment;
use crate::fs::resolve::{
    canonicalize_root, resolve_in_worktree, resolve_in_worktree_with_root, resolve_reason_message,
    ResolveReason,
};
use crate::git::worktree_validity::WorktreeValidity;

/// Entry kind, mirrored by the renderer's `FileTreeEntryKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileTreeEntryKind {
    File,
    Folder,
    CannotAccess,
}

/// One listing entry. `git_status` is merged in by the renderer, so it is always `None` here.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeNode {
    pub path: String,
    pub name: String,
    pub kind: FileTreeEntryKind,
}

/// A successful listing: capped entries plus how many were truncated.
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

/// Result of a directory listing.
pub type ListDirectoryResult = Result<ListDirectoryOk, ListDirectoryError>;

#[derive(Debug)]
pub enum ResolveTargetOk {
    Root(PathBuf),
    Path(PathBuf),
}

impl ResolveTargetOk {
    /// Canonical path of the resolved target.
    pub fn real_path(&self) -> &Path {
        match self {
            ResolveTargetOk::Root(p) | ResolveTargetOk::Path(p) => p,
        }
    }
}

/// Resolves a listing target. `""` is the root, which must be a valid worktree (#729). Rejects `.git` both as typed and after realpath.
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

/// Caps entries per listing in the backend, so a huge directory cannot force unbounded work.
const MAX_ENTRIES_PER_DIRECTORY: usize = 1000;

/// Bounds concurrent symlink classification, so a folder full of links (e.g. pnpm `node_modules`) doesn't serialise.
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

/// Classifies one link using the shared hardened resolver. Any escaping or unsafe target is `cannot-access`.
/// The root is pre-canonicalized so each entry skips a redundant `canonicalize`.
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

/// Lists one directory. `session_id` keys the #729 validity cache for root listings.
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
