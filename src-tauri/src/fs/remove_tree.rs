// Issue #891 gate round 1 (Skippy, delegated by Stuart 2026-10-19, issuecomment-6273798707 item
// 1): `std::fs::remove_dir_all`, not Refract's own hand-rolled walker (this module's original
// form -- `symlink_metadata` per entry, re-checking the reparse attribute before each descent,
// clearing read-only, `\\?\`-prefixing long paths). Two reviewers independently checked the
// Rust 1.96 standard library's own Windows implementation: it opens every entry relative to its
// PARENT's own directory HANDLE with `OBJ_DONT_REPARSE`/`FILE_OPEN_REPARSE_POINT` (never follows
// a junction or symlink down into its target -- the one invariant this whole module exists to
// guarantee), deletes via `FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE` (read-only handled
// with no separate clear step), and has no `MAX_PATH` limit at all (handle-relative opens, never
// a `\\?\`-prefixed path string). A path-string-based walker -- this module's own prior form --
// keeps open a mid-walk TOCTOU swap window (the CVE-2022-21658 class) that std's handle-relative
// implementation closes.
//
// Refract's own remaining responsibility is exactly the containment gate, run ONCE before
// `remove_dir_all` is ever called:
//   1. `symlink_metadata` on `path` ITSELF, refusing outright if it is a link -- `remove_dir_all`
//      only protects against a link MET DURING the walk, never one sitting at the walk's own
//      root (removing a junction's target's own entries instead of just the link back would be
//      exactly the #599/#656 class of bug this whole module exists to never repeat).
//   2. Canonicalize ONCE (refusing rather than falling back if that fails -- deliberately NOT
//      `worktree_validity::canonical_comparable_path`'s own behaviour, which falls back to the
//      uncanonicalized path for a path that may legitimately not exist yet; here, a path this
//      module is about to irreversibly delete must resolve for real or not be touched at all).
//   3. Require that canonical form to be a STRICT descendant of `boundary_root`'s own canonical
//      form (never the root itself, never a path reached only via an upstream junction
//      redirecting elsewhere -- `worktree_delete_tests.rs`'s own
//      `remove_session_worktree_leaves_a_marker_outside_a_junction_planted_inside_the_root` locks
//      this in, and still passes unchanged against this rewrite: the containment INVARIANT is
//      identical, only the removal mechanism inside it changed).
//
// All three steps, plus the actual `remove_dir_all` call, run in ONE `tokio::task::
// spawn_blocking`: every step is synchronous I/O, and splitting it across several separate
// `tokio::fs` awaits (each with its OWN internal `spawn_blocking`) would reopen exactly the kind
// of TOCTOU window BETWEEN steps that `remove_dir_all` closes WITHIN itself but cannot close
// against whatever Refract does outside its one call.

use std::path::{Path, PathBuf};

use crate::git::worktree_validity::comparable_path;

#[derive(Debug)]
pub enum RemoveTreeError {
    /// `path` is a symlink/junction itself, canonicalization failed, or its canonical form is
    /// not a strict descendant of the boundary root (or IS the root itself) -- refused before
    /// anything on disk is touched.
    OutsideBoundary,
    /// `std::fs::remove_dir_all`'s own failure (a holder appeared mid-delete, a file still open
    /// somewhere underneath, etc.) -- `path` is exactly the canonical root this call was
    /// removing; a partial failure leaves whatever `remove_dir_all` already deleted gone, and a
    /// later Retry re-walks from scratch with only less left to remove.
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
}

impl std::fmt::Display for RemoveTreeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OutsideBoundary => write!(f, "refused: outside the worktrees root"),
            Self::Io { path, source } => write!(f, "{}: {source}", path.display()),
        }
    }
}

/// Removes `path` (a real directory) and everything under it via `std::fs::remove_dir_all`,
/// refusing outright unless `path` is a real (non-link) directory that canonicalizes to a
/// strict descendant of `boundary_root` (never the root itself). See this module's own header
/// for why `remove_dir_all` is the decided remover and why every step runs in one
/// `spawn_blocking`.
pub async fn remove_tree(path: &Path, boundary_root: &Path) -> Result<(), RemoveTreeError> {
    let path = path.to_path_buf();
    let boundary_root = boundary_root.to_path_buf();
    tokio::task::spawn_blocking(move || remove_tree_blocking(&path, &boundary_root))
        .await
        .unwrap_or(Err(RemoveTreeError::OutsideBoundary))
}

fn remove_tree_blocking(path: &Path, boundary_root: &Path) -> Result<(), RemoveTreeError> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if !meta.file_type().is_symlink() => {}
        _ => return Err(RemoveTreeError::OutsideBoundary),
    }

    let canonical_path = dunce::canonicalize(path).map_err(|_| RemoveTreeError::OutsideBoundary)?;
    let canonical_root =
        dunce::canonicalize(boundary_root).map_err(|_| RemoveTreeError::OutsideBoundary)?;
    // Same lexical lowercasing `worktree_validity::canonical_comparable_path` uses for its own
    // final compare, reused directly here (`comparable_path` is `pub(crate)`) rather than
    // duplicated -- both inputs are already absolute, real, canonical paths at this point, so
    // its relative-path/`current_dir` branch never triggers.
    let path_key = comparable_path(&canonical_path.to_string_lossy());
    let root_key = comparable_path(&canonical_root.to_string_lossy());
    let prefix = format!("{root_key}{}", std::path::MAIN_SEPARATOR);
    if path_key == root_key || !path_key.starts_with(&prefix) {
        return Err(RemoveTreeError::OutsideBoundary);
    }

    std::fs::remove_dir_all(&canonical_path).map_err(|source| RemoveTreeError::Io {
        path: canonical_path,
        source,
    })
}
