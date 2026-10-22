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

/// Issue #891 gate round 2 (M1): the containment/link-refusal gate shared by `remove_tree`
/// itself (the removal) and `worktree_holders`'s own two checks (the Restart Manager walk and
/// the rename probe) -- all three must refuse a link sitting at `path` itself and then operate
/// on the SAME canonicalized, contained path, never three independently-resolved copies of it.
/// Distinguishes a path that simply does not exist (`Missing`, never itself a refusal -- the
/// holder checks treat "nothing there" as "nothing to hold") from one that exists but is a
/// link, fails to canonicalize, or canonicalizes outside `boundary_root` (`OutsideBoundary`,
/// always a hard refusal). Blocking I/O; callers run it inside their own `spawn_blocking`.
pub enum ContainmentCheck {
    Missing,
    OutsideBoundary,
    Ok(PathBuf),
}

pub fn checked_canonical_path(path: &Path, boundary_root: &Path) -> ContainmentCheck {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => return ContainmentCheck::OutsideBoundary,
        Ok(_) => {}
        // Issue #891 gate round 3 (M2): only "genuinely does not exist" maps to `Missing` --
        // any OTHER lstat error (permission denied, a path component that is not a directory,
        // an I/O error) is refused outright, never silently treated the same as "nothing
        // there, nothing to hold/remove".
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return ContainmentCheck::Missing,
        Err(_) => return ContainmentCheck::OutsideBoundary,
    }

    let Ok(canonical_path) = dunce::canonicalize(path) else {
        return ContainmentCheck::OutsideBoundary;
    };
    let Ok(canonical_root) = dunce::canonicalize(boundary_root) else {
        return ContainmentCheck::OutsideBoundary;
    };
    // Same lexical lowercasing `worktree_validity::canonical_comparable_path` uses for its own
    // final compare, reused directly here (`comparable_path` is `pub(crate)`) rather than
    // duplicated -- both inputs are already absolute, real, canonical paths at this point, so
    // its relative-path/`current_dir` branch never triggers.
    let path_key = comparable_path(&canonical_path.to_string_lossy());
    let root_key = comparable_path(&canonical_root.to_string_lossy());
    let prefix = format!("{root_key}{}", std::path::MAIN_SEPARATOR);
    if path_key == root_key || !path_key.starts_with(&prefix) {
        return ContainmentCheck::OutsideBoundary;
    }
    ContainmentCheck::Ok(canonical_path)
}

/// Issue #891 gate round 3 (H2): Main's own root-cause finding -- the "transient sharing
/// violation" scenarios (c)/(d) hit live was Refract's OWN background `deleteCheck` refresh
/// racing the removal (fixed at the source by `worktree_access`'s read/write lock, H1), but a
/// genuinely external, truly transient holder (a brief antivirus/indexer scan) is still a real
/// possibility `remove_dir_all` itself can hit. Retried here, product-side, rather than only in
/// the live-check script: bounded (10 attempts, 300ms apart) and ONLY for the specific raw OS
/// errors that mean "something had a handle open a moment ago" (32 `ERROR_SHARING_VIOLATION`,
/// 33 `ERROR_LOCK_VIOLATION`, 5 `ERROR_ACCESS_DENIED`, 145 `ERROR_DIR_NOT_EMPTY` -- the last
/// possible if something else briefly recreated an entry mid-walk). `checked_canonical_path` is
/// re-run before EACH attempt, not just once up front: a long retry window must re-confirm the
/// path is still the same real, contained directory it was, never trust a stale resolution.
const REMOVE_RETRY_ATTEMPTS: u32 = 10;
const REMOVE_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(300);

fn is_retryable_remove_error(err: &std::io::Error) -> bool {
    matches!(
        err.raw_os_error(),
        Some(32) | Some(33) | Some(5) | Some(145)
    )
}

fn remove_tree_blocking(path: &Path, boundary_root: &Path) -> Result<(), RemoveTreeError> {
    for attempt in 1..=REMOVE_RETRY_ATTEMPTS {
        let canonical_path = match checked_canonical_path(path, boundary_root) {
            ContainmentCheck::Ok(p) => p,
            // `remove_tree`'s own callers already resolve "does this exist" separately before
            // ever calling remove -- a missing path reaching here is as much a refusal to
            // remove as an out-of-bounds one, matching this function's original behaviour
            // (both outcomes used the same `_ => Err(OutsideBoundary)` arm). Never retried:
            // containment is a hard refusal, not a transient condition.
            ContainmentCheck::Missing | ContainmentCheck::OutsideBoundary => {
                return Err(RemoveTreeError::OutsideBoundary)
            }
        };

        match std::fs::remove_dir_all(&canonical_path) {
            Ok(()) => return Ok(()),
            Err(source) => {
                if is_retryable_remove_error(&source) && attempt < REMOVE_RETRY_ATTEMPTS {
                    std::thread::sleep(REMOVE_RETRY_DELAY);
                    continue;
                }
                return Err(RemoveTreeError::Io {
                    path: canonical_path,
                    source,
                });
            }
        }
    }
    unreachable!("the loop above always returns on its final iteration")
}
