// Shared pathspec containment check for the Git changes panel (spec 018 slice 1, issue #464),
// split out of `changes_status.rs` (issue #806, "no god files" -- that file crossed the 600-line
// cap again once this security hardening landed) so `changes_status.rs` and `changes_diff.rs`
// (both already `super::`-siblings under `git::`) share ONE copy rather than one owning it and
// the other importing across an otherwise-unrelated module boundary.

use std::path::{Path, PathBuf};

use crate::fs::resolve::is_unsafe_token;

use super::git::{GitError, GitErrorCode};

/// 2026-10-20 security hardening (Skippy, delegated by Stuart): refuses a pathspec BEFORE it is
/// ever built into a `git` argv, rather than relying solely on the `--` separator every caller
/// (`changes_status::stage_files`/`unstage_files`, `changes_diff::diff_text`) already places
/// ahead of its pathspecs to stop option-reinterpretation. Two layers: `fs::resolve::
/// is_unsafe_token` (shared with the File explorer lane, #790 -- an embedded NUL, a UNC/
/// device-ish `//`/`\\` prefix, a drive prefix or drive-relative token, an NTFS alternate-data-
/// stream colon, a reserved Windows device name in any segment) plus this function's own checks
/// for a leading `-` (git-option reinterpretation, defense in depth), a leading `/`/`\\` or
/// `Path::is_absolute` (a single-rooted-no-prefix or drive-absolute token `is_unsafe_token` alone
/// would not catch), and any `..` path component (traversal); then a lexical join onto
/// `worktree_path` confirming the result is a STRICT descendant of the worktree root -- no disk
/// access (unlike `fs::remove_tree::checked_canonical_path`'s `dunce::canonicalize`): a path here
/// may legitimately not exist yet (a deleted-but-staged file, or one about to be restored), so
/// requiring it to resolve on disk would wrongly refuse a real, in-scope operation. A tracked
/// symlink pointing outside the worktree is not a threat this check needs to cover either way --
/// `git add`/`restore`/`diff` all operate on the symlink's own blob, never read through it.
pub(super) fn validate_pathspec(worktree_path: &Path, path: &str) -> Result<(), GitError> {
    let refuse = || GitError::new(GitErrorCode::OutsideWorktree, format!("refused unsafe path: {path}"));
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
