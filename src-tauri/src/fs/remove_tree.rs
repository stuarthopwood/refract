// Issue #891: Refract's own long-path-safe recursive remover (Skippy's 2026-10-19 decision),
// replacing both the `NotEmpty` dead-end `git/worktree_delete.rs`'s orphan path used to hit and
// the reliance on `git worktree remove --force` to delete a REGISTERED worktree's own files
// (which cannot reliably remove a full Windows `node_modules` tree: long paths, read-only
// files, and the junctions pnpm itself plants inside `node_modules/.pnpm`). Never
// `std::fs::remove_dir_all`: that function does not clear read-only attributes, does not switch
// to `\\?\` verbatim paths for a long path, and -- the part that actually matters -- recurses
// through anything `symlink_metadata` calls a directory, which includes a junction. Removing a
// junction's TARGET contents instead of just the link back would be exactly the #599/#656 class
// of bug this whole module exists to never repeat.
//
// Containment: canonicalizes `path` via `worktree_validity::canonical_comparable_path` (resolves
// junctions/symlinks, `dunce`-clean) and refuses outright unless it is a STRICT descendant of
// `boundary_root`'s own canonical form -- catching not only "remove the worktrees root itself"
// but a worktree path reached only through an upstream junction redirecting it entirely outside
// the root (`worktree_delete_tests.rs`'s own
// `remove_session_worktree_leaves_a_marker_outside_a_junction_planted_inside_the_root`:
// `worktrees_root/junc/session` is lexically inside the root, but `junc` is a junction, so its
// canonical form resolves to wherever `junc`'s real target actually is). This check runs before
// anything is touched, so a path that escapes is refused, not partially deleted.
//
// Idempotent by construction (matches `remove_session_worktree`'s own contract): a partial
// failure (a holder appears mid-delete after the preflight passed) leaves whatever is already
// gone, gone, and returns exactly which path it failed on -- a later Retry re-walks from
// scratch and only ever has less left to remove.

use std::future::Future;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use crate::git::worktree_validity::canonical_comparable_path;

#[derive(Debug)]
pub enum RemoveTreeError {
    /// `path` does not canonicalize to a strict descendant of the boundary root (or IS the root
    /// itself) -- refused before anything on disk is touched.
    OutsideBoundary,
    /// An I/O failure partway through: `path` is exactly what failed on, so a retry (the whole
    /// removal path this feeds is idempotent) has strictly less left to do, not a clean slate.
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

/// Over this many UTF-16 code units Windows needs the `\\?\` verbatim prefix (260 is
/// `MAX_PATH`; used here as a simple, conservative threshold rather than the exact
/// per-component budget `CreateFile` actually enforces).
const LONG_PATH_THRESHOLD: usize = 260;

/// `\\?\`-prefixes `p` when it is long enough to need it. Every path this module builds is
/// already fully-qualified and backslash-separated -- but NOT necessarily `..`-free: callers
/// are responsible for canonicalizing the ROOT path once before building any child paths from
/// it (`remove_tree`'s own doc comment explains why this function itself must never do that).
fn long_path(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if s.len() < LONG_PATH_THRESHOLD || s.starts_with(r"\\?\") {
        return p.to_path_buf();
    }
    match s.strip_prefix(r"\\") {
        Some(unc) => PathBuf::from(format!(r"\\?\UNC\{unc}")),
        None => PathBuf::from(format!(r"\\?\{s}")),
    }
}

/// `FILE_ATTRIBUTE_DIRECTORY` (0x10): Rust's own cross-platform `FileType::is_dir()` always
/// returns `false` for anything `is_symlink()` reports true for (symlink and directory are
/// mutually exclusive categories in std's model), which is exactly wrong for deciding whether a
/// LINK itself needs `RemoveDirectoryW` or `DeleteFileW` -- a junction (always a directory-type
/// reparse point) still has this raw attribute bit set even though `is_dir()` reports `false`
/// for it. Checked directly via `MetadataExt::file_attributes()` instead of `is_dir()` wherever
/// a link's own removal call needs to pick the right one.
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;

fn is_directory_attribute(meta: &std::fs::Metadata) -> bool {
    meta.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0
}

/// `set_readonly(false)` is a cross-platform footgun clippy warns about (on Unix it makes a
/// file world-writable), but this whole build is Windows-only (constitution, spec.md
/// Assumptions): here it only ever clears the `FILE_ATTRIBUTE_READONLY` bit, never touching any
/// Unix permission bit.
#[allow(clippy::permissions_set_readonly_false)]
async fn clear_readonly(p: &Path) {
    if let Ok(meta) = tokio::fs::metadata(long_path(p)).await {
        let mut perms = meta.permissions();
        if perms.readonly() {
            perms.set_readonly(false);
            let _ = tokio::fs::set_permissions(long_path(p), perms).await;
        }
    }
}

/// Removes exactly one entry that is a link (symlink or junction -- both are "name surrogate"
/// reparse points, which is what `symlink_metadata`'s own `is_symlink()` checks on Windows, so
/// it is true for a junction too): NEVER descends into it, removing only the link itself, so
/// whatever it points to is always left untouched. Deliberately never clears a read-only
/// attribute through this path: `clear_readonly`'s own `tokio::fs::metadata` call FOLLOWS a
/// reparse point to whatever it points to, so calling it on a link would read and could
/// rewrite the TARGET's own permissions -- exactly the kind of outside-the-boundary touch this
/// whole module exists to never make. `RemoveDirectoryW`/`DeleteFileW` remove a reparse point
/// fine regardless of its own attributes; no real-world junction has been observed read-only.
async fn remove_link(p: &Path, is_dir: bool) -> std::io::Result<()> {
    let target = long_path(p);
    if is_dir {
        tokio::fs::remove_dir(&target).await
    } else {
        tokio::fs::remove_file(&target).await
    }
}

/// Recursively removes every entry UNDER `dir` (never `dir` itself -- the caller removes that
/// once this returns). Re-reads `dir`'s own `symlink_metadata` right before listing it (the
/// "re-check the reparse attribute right before each descent" decision): a TOCTOU window where
/// something swapped a real directory for a junction between being listed by its PARENT and
/// being opened here would otherwise let this function follow it.
fn remove_contents(
    dir: PathBuf,
) -> Pin<Box<dyn Future<Output = Result<(), RemoveTreeError>> + Send>> {
    Box::pin(async move {
        let meta = tokio::fs::symlink_metadata(long_path(&dir))
            .await
            .map_err(|source| RemoveTreeError::Io {
                path: dir.clone(),
                source,
            })?;
        if meta.file_type().is_symlink() {
            // `dir` itself turned into a link since its parent listed it: never follow it, and
            // nothing to remove here (the caller removes the link, not this function).
            return Ok(());
        }
        let mut entries = tokio::fs::read_dir(long_path(&dir))
            .await
            .map_err(|source| RemoveTreeError::Io {
                path: dir.clone(),
                source,
            })?;
        while let Some(entry) =
            entries
                .next_entry()
                .await
                .map_err(|source| RemoveTreeError::Io {
                    path: dir.clone(),
                    source,
                })?
        {
            let child = dir.join(entry.file_name());
            let child_meta = entry
                .metadata()
                .await
                .map_err(|source| RemoveTreeError::Io {
                    path: child.clone(),
                    source,
                })?;
            if child_meta.file_type().is_symlink() {
                remove_link(&child, is_directory_attribute(&child_meta))
                    .await
                    .map_err(|source| RemoveTreeError::Io {
                        path: child.clone(),
                        source,
                    })?;
                continue;
            }
            if child_meta.is_dir() {
                remove_contents(child.clone()).await?;
                clear_readonly(&child).await;
                tokio::fs::remove_dir(long_path(&child))
                    .await
                    .map_err(|source| RemoveTreeError::Io {
                        path: child.clone(),
                        source,
                    })?;
            } else {
                clear_readonly(&child).await;
                tokio::fs::remove_file(long_path(&child))
                    .await
                    .map_err(|source| RemoveTreeError::Io {
                        path: child.clone(),
                        source,
                    })?;
            }
        }
        Ok(())
    })
}

/// Removes `path` (a real directory) and everything under it, refusing outright unless `path`
/// canonicalizes to a strict descendant of `boundary_root` (never the root itself).
pub async fn remove_tree(path: &Path, boundary_root: &Path) -> Result<(), RemoveTreeError> {
    let root_key = canonical_comparable_path(boundary_root).await;
    let path_key = canonical_comparable_path(path).await;
    let prefix = format!("{root_key}{}", std::path::MAIN_SEPARATOR);
    if path_key == root_key || !path_key.starts_with(&prefix) {
        return Err(RemoveTreeError::OutsideBoundary);
    }
    // Issue #891: canonicalize ONCE here (never inside `long_path`, which must never risk
    // following a reparse point on every call -- confirmed `canonical_comparable_path`'s own
    // `dunce::canonicalize` call resolves symlinks/junctions to their real target, which would
    // be exactly wrong for `remove_link`'s own target or `remove_contents`'s own TOCTOU
    // re-check) so every child path `remove_contents` builds via `.join()` from this point on
    // is already absolute and free of any `..`/`.` component. A lexical `..` survives into a
    // `\\?\` verbatim prefix completely unresolved (Windows does not parse one specially
    // inside a verbatim path the way it does an ordinary one), which made `long_path`'s own
    // naive string-prefixing produce a syntactically invalid path the moment a deep enough
    // child actually needed the prefix (`ERROR_INVALID_NAME`, confirmed live against this
    // issue's own 260+-character test fixture, built under `worktrees_root()`'s own lexical
    // `repo/../pinion-worktrees/<name>` join). `path` is guaranteed to be a real, non-link
    // directory by the time this is reached (`remove_session_worktree` already refuses a
    // symlink AT the worktree path itself before ever calling this), so canonicalizing it here,
    // once, can never silently redirect onto a different target the way canonicalizing on
    // every deeper call could have. Falls back to the original `path` if canonicalization
    // fails for some reason; the first `tokio::fs::symlink_metadata` inside `remove_contents`
    // surfaces that failure properly either way.
    let owned = path.to_path_buf();
    let canonical_path = tokio::task::spawn_blocking(move || dunce::canonicalize(&owned))
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_else(|| path.to_path_buf());

    remove_contents(canonical_path.clone()).await?;
    clear_readonly(&canonical_path).await;
    tokio::fs::remove_dir(long_path(&canonical_path))
        .await
        .map_err(|source| RemoveTreeError::Io {
            path: canonical_path.clone(),
            source,
        })
}
