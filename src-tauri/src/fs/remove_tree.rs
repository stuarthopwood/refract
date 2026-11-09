// Uses `std::fs::remove_dir_all`, which does not follow links mid-walk. Refusal of a link at the
// root and the strict-descendant check run first, in one blocking task, to avoid a TOCTOU gap.

use std::path::{Path, PathBuf};

use crate::git::worktree_validity::comparable_path;

#[derive(Debug)]
pub enum RemoveTreeError {
    /// Refused before anything was touched: a link, or not a strict descendant of the boundary.
    OutsideBoundary,
    /// `remove_dir_all` failed; a partial delete is possible, and a retry re-walks.
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    /// A retry resolved the path somewhere other than where attempt 1 did; earlier attempts may
    /// have deleted files, so this is never worded "did not delete anything".
    PathChanged { path: PathBuf },
    /// The path could not be checked. `after_partial` means an earlier attempt may have deleted files.
    Unreadable {
        path: PathBuf,
        source: std::io::Error,
        after_partial: bool,
    },
}

impl std::fmt::Display for RemoveTreeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OutsideBoundary => write!(f, "refused: outside the worktrees root"),
            Self::PathChanged { path } => {
                write!(f, "{}: resolved somewhere else on a retry", path.display())
            }
            Self::Io { path, source } | Self::Unreadable { path, source, .. } => {
                write!(f, "{}: {source}", path.display())
            }
        }
    }
}

/// Removes `path` under `boundary_root`, refusing links and the root itself.
pub async fn remove_tree(path: &Path, boundary_root: &Path) -> Result<(), RemoveTreeError> {
    let path = path.to_path_buf();
    let boundary_root = boundary_root.to_path_buf();
    tokio::task::spawn_blocking(move || remove_tree_blocking(&path, &boundary_root))
        .await
        .unwrap_or(Err(RemoveTreeError::OutsideBoundary))
}

/// Outcome of the containment gate shared by removal and holder checks.
pub enum ContainmentCheck {
    Missing,
    OutsideBoundary,
    /// Check failed for a reason other than not-found (#1158).
    Unreadable(std::io::Error),
    Ok(PathBuf),
}

/// Canonicalises `path` and checks it stays inside `boundary_root`.
pub fn checked_canonical_path(path: &Path, boundary_root: &Path) -> ContainmentCheck {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => return ContainmentCheck::OutsideBoundary,
        Ok(_) => {}
        // Only true not-found is `Missing`; other errors are refused, never treated as absent.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return ContainmentCheck::Missing,
        Err(e) => return ContainmentCheck::Unreadable(e),
    }

    let canonical_path = match dunce::canonicalize(path) {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return ContainmentCheck::Missing,
        Err(e) => return ContainmentCheck::Unreadable(e),
    };
    let canonical_root = match dunce::canonicalize(boundary_root) {
        Ok(p) => p,
        Err(e) => return ContainmentCheck::Unreadable(e),
    };
    // Reuses the same comparable-path form as `worktree_validity`.
    let path_key = comparable_path(&canonical_path.to_string_lossy());
    let root_key = comparable_path(&canonical_root.to_string_lossy());
    let prefix = format!("{root_key}{}", std::path::MAIN_SEPARATOR);
    if path_key == root_key || !path_key.starts_with(&prefix) {
        return ContainmentCheck::OutsideBoundary;
    }
    ContainmentCheck::Ok(canonical_path)
}

/// Bounded retry for transient Windows sharing errors; the path is re-checked on each attempt.
const REMOVE_RETRY_ATTEMPTS: u32 = 10;
const REMOVE_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(300);

fn is_retryable_remove_error(err: &std::io::Error) -> bool {
    matches!(
        err.raw_os_error(),
        Some(32) | Some(33) | Some(5) | Some(145)
    )
}

fn remove_tree_blocking(path: &Path, boundary_root: &Path) -> Result<(), RemoveTreeError> {
    // Attempt 1's canonical path; a retry that resolves elsewhere means a link was swapped in
    // during the retry window, so it is refused rather than followed.
    let mut pinned: Option<PathBuf> = None;
    for attempt in 1..=REMOVE_RETRY_ATTEMPTS {
        let canonical_path = match checked_canonical_path(path, boundary_root) {
            ContainmentCheck::Ok(p) => match &pinned {
                Some(first)
                    if comparable_path(&first.to_string_lossy())
                        != comparable_path(&p.to_string_lossy()) =>
                {
                    return Err(RemoveTreeError::PathChanged {
                        path: first.clone(),
                    });
                }
                Some(_) => p,
                None => {
                    pinned = Some(p.clone());
                    p
                }
            },
            // After attempt 1, a vanished root means an earlier pass finished the job (#1158).
            ContainmentCheck::Missing if attempt > 1 => return Ok(()),
            ContainmentCheck::Missing | ContainmentCheck::OutsideBoundary => {
                return Err(RemoveTreeError::OutsideBoundary)
            }
            ContainmentCheck::Unreadable(source) => {
                if is_retryable_remove_error(&source) && attempt < REMOVE_RETRY_ATTEMPTS {
                    log_retry(attempt, path, &source);
                    std::thread::sleep(REMOVE_RETRY_DELAY);
                    continue;
                }
                return Err(RemoveTreeError::Unreadable {
                    path: path.to_path_buf(),
                    source,
                    after_partial: attempt > 1,
                });
            }
        };

        match std::fs::remove_dir_all(&canonical_path) {
            Ok(()) => return Ok(()),
            Err(source) => {
                if is_retryable_remove_error(&source) && attempt < REMOVE_RETRY_ATTEMPTS {
                    log_retry(attempt, &canonical_path, &source);
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

// Live evidence needs to tell a first-try success from one a retry quietly absorbed.
fn log_retry(attempt: u32, path: &Path, source: &std::io::Error) {
    log::debug!(
        "remove_tree: attempt {attempt} of {REMOVE_RETRY_ATTEMPTS} failed for {} (os error {:?}): {source}; retrying",
        path.display(),
        source.raw_os_error()
    );
}
