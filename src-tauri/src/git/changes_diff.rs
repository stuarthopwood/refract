// Single-file diff-text reader for the Git changes panel, split out of `changes_status.rs`.

use std::path::Path;
use std::time::Duration;

use super::changes_score::{resolve_untracked_entry, UntrackedEntry};
use super::git::{git_raw, GitError, GitErrorCode};
use super::pathspec::validate_pathspec;
use crate::fs::read_preview::{read_preview, FilePreviewKind};
use crate::fs::resolve::{resolve_reason_message, ResolveReason};

/// Re-declared because `changes_status.rs`'s copy is private.
const DIFF_TIMEOUT: Duration = Duration::from_secs(5);

/// Shown instead of an empty patch, so an empty box is never mistaken for an empty file.
const REASON_BINARY: &str = "Binary file";
const REASON_IMAGE: &str = "Image file";
const REASON_TOO_LARGE: &str = "Too large to preview (over 1 MiB)";
const REASON_READ_ERROR: &str = "Couldn't read this file";

/// Re-checks the renderer's `untracked` flag against `git ls-files -z`, so a stale flag never
/// reaches the filesystem. `-z` avoids git's C-quoting of non-ASCII paths.
async fn confirm_untracked(worktree_path: &Path, path: &str) -> bool {
    let result = git_raw(
        worktree_path,
        &[
            "--literal-pathspecs",
            "-c",
            "core.fsmonitor=false",
            "--no-optional-locks",
            "ls-files",
            "-z",
            "--others",
            "--exclude-standard",
            "--",
            path,
        ],
        Some(DIFF_TIMEOUT),
    )
    .await;
    if result.code != 0 {
        return false;
    }
    let normalized = path.replace('\\', "/");
    result
        .stdout
        .split('\0')
        .any(|record| !record.is_empty() && record == normalized)
}

/// Maps a `ResolveReason` onto `GitError`. Disk-state reasons fold onto `GitFailed` because
/// they are race-only here.
fn map_resolve_reason(reason: ResolveReason) -> GitError {
    let code = match reason {
        ResolveReason::OutsideWorktree => GitErrorCode::OutsideWorktree,
        ResolveReason::WorktreeMissing | ResolveReason::FileMissing => GitErrorCode::GitFailed,
    };
    GitError::new(code, resolve_reason_message(reason, "file"))
}

/// Normalises CRLF and lone CR to LF in one pass.
fn normalize_newlines(content: &str) -> String {
    let mut normalized = String::with_capacity(content.len());
    let mut chars = content.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            normalized.push('\n');
        } else {
            normalized.push(c);
        }
    }
    normalized
}

/// Builds a whole-file `+` hunk, counting lines like `changes_score::count_lines` so the
/// declared count matches the "+N" badge.
fn build_added_patch(content: &str) -> String {
    let normalized = normalize_newlines(content);
    let has_trailing_newline = normalized.ends_with('\n');
    let trimmed = normalized.strip_suffix('\n').unwrap_or(&normalized);
    if trimmed.is_empty() {
        return String::new();
    }
    let lines: Vec<&str> = trimmed.split('\n').collect();
    let mut patch = format!("@@ -0,0 +1,{} @@\n", lines.len());
    for line in &lines {
        patch.push('+');
        patch.push_str(line);
        patch.push('\n');
    }
    if !has_trailing_newline {
        patch.push_str("\\ No newline at end of file\n");
    }
    patch
}

/// Renders an untracked file as an all-additions hunk. A symlink renders its target text,
/// never the target's contents. Containment is checked by `resolve_untracked_entry`.
async fn untracked_file_patch(
    worktree_path: &Path,
    path: &str,
) -> Result<(String, Option<&'static str>), GitError> {
    let read = async {
        let entry = match resolve_untracked_entry(worktree_path, path).await {
            Ok(entry) => entry,
            Err(reason) => return Err(map_resolve_reason(reason)),
        };
        match entry {
            UntrackedEntry::Missing | UntrackedEntry::NotAFile => Ok((String::new(), None)),
            UntrackedEntry::Symlink { target_text } => {
                Ok((format!("@@ -0,0 +1,1 @@\n+{target_text}\n"), None))
            }
            UntrackedEntry::File { resolved } => {
                let preview = read_preview(&resolved, path).await;
                match preview.kind {
                    FilePreviewKind::Text | FilePreviewKind::Markdown => Ok((
                        build_added_patch(&preview.content.unwrap_or_default()),
                        None,
                    )),
                    FilePreviewKind::Binary => Ok((String::new(), Some(REASON_BINARY))),
                    FilePreviewKind::Image => Ok((String::new(), Some(REASON_IMAGE))),
                    FilePreviewKind::TooLarge => Ok((String::new(), Some(REASON_TOO_LARGE))),
                    FilePreviewKind::ReadError => Ok((String::new(), Some(REASON_READ_ERROR))),
                    // A mid-read deletion is a race, not a refusal, so it carries no reason.
                    FilePreviewKind::Deleted => Ok((String::new(), None)),
                }
            }
        }
    };
    tokio::time::timeout(DIFF_TIMEOUT, read)
        .await
        .unwrap_or_else(|_| Ok((String::new(), Some(REASON_READ_ERROR))))
}

/// Returns the hunk-only diff for one file, staged or unstaged, with git's header lines
/// stripped. An untracked flag is re-confirmed server-side before use.
pub async fn diff_text(
    worktree_path: &Path,
    path: &str,
    staged: bool,
    untracked: bool,
) -> Result<(String, Option<&'static str>), GitError> {
    validate_pathspec(worktree_path, path)?;
    if untracked && confirm_untracked(worktree_path, path).await {
        return untracked_file_patch(worktree_path, path).await;
    }
    // Disables external diff and textconv so a repo's own config never runs an arbitrary command.
    let mut args: Vec<&str> = vec![
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "--no-optional-locks",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
    ];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(path);
    let result = git_raw(worktree_path, &args, Some(DIFF_TIMEOUT)).await;
    if result.code != 0 {
        let detail = if !result.stderr.trim().is_empty() {
            result.stderr.trim()
        } else {
            result.stdout.trim()
        };
        return Err(GitError::new(
            GitErrorCode::GitFailed,
            format!("git {} failed: {detail}", args.join(" ")),
        ));
    }
    match result.stdout.find("\n@@") {
        Some(at) => Ok((result.stdout[at + 1..].to_string(), None)),
        None => Ok((String::new(), None)),
    }
}
