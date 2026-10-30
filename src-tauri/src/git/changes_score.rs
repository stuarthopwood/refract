// Split from changes_status.rs to keep it under the 600-line cap (#806).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::fs::paths::contains_git_segment;
use crate::fs::read_preview::{read_preview, FilePreviewKind};
use crate::fs::resolve::{
    canonicalize_root, normalize_lexical, resolve_in_worktree_with_root, ResolveReason,
};

/// Counts lines, treating a trailing newline as the end of the last line.
fn count_lines(text: &str) -> i64 {
    if text.is_empty() {
        return 0;
    }
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = normalized.strip_suffix('\n').unwrap_or(&normalized);
    if trimmed.is_empty() {
        return 0;
    }
    trimmed.split('\n').count() as i64
}

/// Parses `--numstat -z` output into a path to (additions, deletions) map, never trimming paths.
pub(super) fn parse_numstat_map(stdout: &str) -> HashMap<String, (i64, i64)> {
    let mut map = HashMap::new();
    for record in stdout.split('\0') {
        if record.is_empty() {
            continue;
        }
        let mut columns = record.splitn(3, '\t');
        let add_raw = columns.next().unwrap_or("");
        let del_raw = columns.next().unwrap_or("");
        let path = columns.next().unwrap_or("");
        if path.is_empty() {
            continue;
        }
        let additions = if add_raw != "-" {
            add_raw.parse::<i64>().unwrap_or(0)
        } else {
            0
        };
        let deletions = if del_raw != "-" {
            del_raw.parse::<i64>().unwrap_or(0)
        } else {
            0
        };
        map.insert(path.to_string(), (additions, deletions));
    }
    map
}

/// One untracked path's classification, shared by the diff and score paths.
pub(super) enum UntrackedEntry {
    /// The leaf is gone, or its metadata could not be read. Treated as a benign race.
    Missing,
    /// The leaf is a symlink or junction. Its target text is shown, and it is never read through.
    Symlink { target_text: String },
    /// The leaf exists but is not a regular file (directory, FIFO, device).
    NotAFile,
    /// A regular file whose canonical, containment-checked path is safe to read.
    File { resolved: PathBuf },
}

/// Resolves `path` under `worktree_path` with containment proof. Classifies the leaf without
/// resolving through a symlink there. Backslashes are normalised first, and `.git` is refused.
pub(super) async fn resolve_untracked_entry(
    worktree_path: &Path,
    path: &str,
) -> Result<UntrackedEntry, ResolveReason> {
    let path = path.replace('\\', "/");
    if contains_git_segment(&path) {
        return Err(ResolveReason::OutsideWorktree);
    }
    let (parent, leaf) = path.rsplit_once('/').unwrap_or(("", &path));
    let root_real = canonicalize_root(worktree_path).await?;
    let unresolved_root = normalize_lexical(worktree_path);
    let resolved_parent = if parent.is_empty() {
        root_real.clone()
    } else {
        resolve_in_worktree_with_root(&root_real, &unresolved_root, parent).await?
    };
    let resolved = resolved_parent.join(leaf);
    let rel_from_root = resolved
        .strip_prefix(&root_real)
        .map_err(|_| ResolveReason::OutsideWorktree)?
        .to_string_lossy()
        .replace('\\', "/");
    if contains_git_segment(&rel_from_root) {
        return Err(ResolveReason::OutsideWorktree);
    }
    let link_metadata = match tokio::fs::symlink_metadata(&resolved).await {
        Ok(metadata) => metadata,
        Err(_) => return Ok(UntrackedEntry::Missing),
    };
    if link_metadata.file_type().is_symlink() {
        // Never read through the link (its target can be a UNC path, i.e. an NTLM/SMB request);
        // `read_link` is single-hop text only.
        resolve_in_worktree_with_root(&root_real, &unresolved_root, &path).await?;
        return Ok(match tokio::fs::read_link(&resolved).await {
            Ok(target) => UntrackedEntry::Symlink {
                target_text: target.to_string_lossy().replace('\\', "/"),
            },
            Err(_) => UntrackedEntry::Missing,
        });
    }
    if !link_metadata.is_file() {
        return Ok(UntrackedEntry::NotAFile);
    }
    let canonical = canonicalize_root(&resolved).await?;
    let canonical_rel = canonical
        .strip_prefix(&root_real)
        .map_err(|_| ResolveReason::OutsideWorktree)?
        .to_string_lossy()
        .replace('\\', "/");
    if contains_git_segment(&canonical_rel) {
        return Err(ResolveReason::OutsideWorktree);
    }
    Ok(UntrackedEntry::File {
        resolved: canonical,
    })
}

/// Scores an untracked file as all-additions, capped at 1 MiB (`partial` above it). Never reads
/// through a symlink, via the shared `resolve_untracked_entry`.
pub(super) async fn score_untracked_file(
    worktree_path: &Path,
    relative_path: &str,
) -> (i64, i64, bool) {
    let entry = match resolve_untracked_entry(worktree_path, relative_path).await {
        Ok(entry) => entry,
        // A resolve or containment failure scores 0/0, not partial, so an escape is never read.
        Err(_) => return (0, 0, false),
    };
    match entry {
        UntrackedEntry::Missing | UntrackedEntry::NotAFile => (0, 0, false),
        UntrackedEntry::Symlink { .. } => (1, 0, false),
        UntrackedEntry::File { resolved } => {
            let preview = read_preview(&resolved, relative_path).await;
            match preview.kind {
                FilePreviewKind::Text | FilePreviewKind::Markdown => {
                    (count_lines(&preview.content.unwrap_or_default()), 0, false)
                }
                FilePreviewKind::TooLarge => (0, 0, true),
                // Binary, race, error, or image: nothing countable, so 0/0 and not partial.
                FilePreviewKind::Binary
                | FilePreviewKind::Deleted
                | FilePreviewKind::ReadError
                | FilePreviewKind::Image => (0, 0, false),
            }
        }
    }
}
