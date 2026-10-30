// A worktree is valid only if git has it registered AND it has its own `.git` entry; a bare
// `exists()` misreports hand-emptied or orphaned folders as healthy (#729).
// Paths are canonicalized first so worktrees reached via junctions still match.

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::git::git;

/// Timeout for the single shared `git worktree list --porcelain` call; a stalled git must not block callers.
const REGISTRY_CHECK_TIMEOUT: Duration = Duration::from_secs(3);

/// Worktree check result; `Unknown` (git timed out) must never be read as `Invalid`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorktreeValidity {
    Valid,
    Invalid,
    Unknown,
}

/// Case- and separator-insensitive comparison key for a path, without touching disk.
/// Duplicated from `store::registry` to avoid exporting across the module boundary.
pub(crate) fn comparable_path(p: &str) -> String {
    let normalized = super::git::normalize_git_path(p);
    let path = Path::new(&normalized);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
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

/// Canonicalizes `p` (resolving junctions) then compares lexically; falls back to the raw path
/// if it doesn't exist. Runs on the blocking pool since canonicalize is synchronous.
pub(crate) async fn canonical_comparable_path(p: &Path) -> String {
    let owned = p.to_path_buf();
    let canonical = tokio::task::spawn_blocking(move || dunce::canonicalize(&owned))
        .await
        .ok()
        .and_then(Result::ok);
    comparable_path(
        &canonical
            .unwrap_or_else(|| p.to_path_buf())
            .to_string_lossy(),
    )
}

/// Parses `git worktree list --porcelain` output into each entry's `worktree <path>` line.
pub(crate) fn parse_porcelain_worktree_paths(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .map(str::to_string)
        .collect()
}

/// Lists registered worktrees' canonical keys with one git call; `None` means timeout.
/// A git failure still returns `Some(vec![])` (a settled "nothing registered" answer).
///
/// Called once per repository, not per Session, to avoid repeated serial listings.
pub(crate) async fn list_registered_worktrees(repo: &Path) -> Option<Vec<String>> {
    let stdout = match tokio::time::timeout(
        REGISTRY_CHECK_TIMEOUT,
        git(repo, &["worktree", "list", "--porcelain"]),
    )
    .await
    {
        Err(_) => return None,
        Ok(Err(_)) => return Some(Vec::new()),
        Ok(Ok(stdout)) => stdout,
    };
    let mut out = Vec::new();
    for raw in parse_porcelain_worktree_paths(&stdout) {
        out.push(canonical_comparable_path(Path::new(&raw)).await);
    }
    Some(out)
}

/// True when git has `worktree_path` registered under `repo`. A timeout maps to `false`
/// (bool contract for its confirmation-text-only caller).
pub(crate) async fn is_worktree_registered(repo: &Path, worktree_path: &Path) -> bool {
    let target = canonical_comparable_path(worktree_path).await;
    list_registered_worktrees(repo)
        .await
        .is_some_and(|list| list.contains(&target))
}

/// Decides Valid/Invalid/Unknown from an already-fetched registered list (`None` = timeout).
pub(crate) async fn registered_validity(
    worktree_path: &Path,
    registered: Option<&[String]>,
) -> WorktreeValidity {
    match registered {
        None => WorktreeValidity::Unknown,
        Some(list) => {
            let target = canonical_comparable_path(worktree_path).await;
            if list.contains(&target) {
                WorktreeValidity::Valid
            } else {
                WorktreeValidity::Invalid
            }
        }
    }
}

/// Valid = registered with git AND has its own `.git` entry; `Unknown` is never read as missing.
pub async fn worktree_is_valid(repo: &Path, worktree_path: &Path) -> WorktreeValidity {
    let has_git_entry = tokio::fs::symlink_metadata(worktree_path.join(".git"))
        .await
        .is_ok();
    if !has_git_entry {
        return WorktreeValidity::Invalid;
    }
    let registered = list_registered_worktrees(repo).await;
    registered_validity(worktree_path, registered.as_deref()).await
}

/// Three-state registration check: a timeout stays `Unknown` so the destructive removal path
/// can ask for a Retry rather than misroute a slow-to-confirm worktree down the orphan path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RegistrationState {
    Registered,
    NotRegistered,
    Unknown,
}

pub(crate) async fn worktree_registration_state(
    repo: &Path,
    worktree_path: &Path,
) -> RegistrationState {
    let target = canonical_comparable_path(worktree_path).await;
    match list_registered_worktrees(repo).await {
        None => RegistrationState::Unknown,
        Some(list) if list.contains(&target) => RegistrationState::Registered,
        Some(_) => RegistrationState::NotRegistered,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::init_repo;
    use crate::git::worktrees::{add_worktree_with_generated_name, worktrees_root};

    #[tokio::test]
    async fn valid_for_a_registered_worktree_with_its_git_pointer() {
        let repo = init_repo().await;
        let added = add_worktree_with_generated_name(&repo, "main")
            .await
            .expect("create worktree");
        assert_eq!(
            worktree_is_valid(&repo, &added.worktree_path).await,
            WorktreeValidity::Valid
        );
    }

    #[tokio::test]
    async fn invalid_for_a_folder_git_has_never_registered() {
        let repo = init_repo().await;
        let orphan = worktrees_root(&repo).join("never-registered");
        tokio::fs::create_dir_all(&orphan).await.unwrap();
        // A `.git` file exists but git never registered it.
        tokio::fs::write(orphan.join(".git"), b"gitdir: /nowhere\n")
            .await
            .unwrap();
        assert_eq!(
            worktree_is_valid(&repo, &orphan).await,
            WorktreeValidity::Invalid
        );
    }

    #[tokio::test]
    async fn invalid_for_an_empty_folder_with_no_git_entry_at_all() {
        let repo = init_repo().await;
        let empty = worktrees_root(&repo).join("just-empty");
        tokio::fs::create_dir_all(&empty).await.unwrap();
        assert_eq!(
            worktree_is_valid(&repo, &empty).await,
            WorktreeValidity::Invalid
        );
    }

    #[tokio::test]
    async fn invalid_for_a_missing_folder() {
        let repo = init_repo().await;
        let missing = worktrees_root(&repo).join("does-not-exist");
        assert_eq!(
            worktree_is_valid(&repo, &missing).await,
            WorktreeValidity::Invalid
        );
    }

    #[tokio::test]
    async fn invalid_for_a_registered_worktree_whose_git_pointer_was_hand_deleted() {
        let repo = init_repo().await;
        let added = add_worktree_with_generated_name(&repo, "main")
            .await
            .expect("create worktree");
        tokio::fs::remove_file(added.worktree_path.join(".git"))
            .await
            .unwrap();
        // Still registered, but no `.git` entry remains (#729).
        assert_eq!(
            worktree_is_valid(&repo, &added.worktree_path).await,
            WorktreeValidity::Invalid
        );
    }

    /// A worktree reached via a junction alias is the SAME registered worktree. Skips only when
    /// a junction can't be created locally; under CI that is a failure.
    #[tokio::test]
    async fn valid_through_a_junction_alias_to_the_same_registered_worktree() {
        let repo = init_repo().await;
        let added = add_worktree_with_generated_name(&repo, "main")
            .await
            .expect("create worktree");
        let junction = added.worktree_path.with_file_name("junction-alias");
        let status = tokio::process::Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                &junction.to_string_lossy(),
                &added.worktree_path.to_string_lossy(),
            ])
            .status()
            .await;
        let is_ci = std::env::var("CI").is_ok();
        let Ok(status) = status else {
            if is_ci {
                panic!("could not spawn mklink under CI; junction test must not silently skip");
            }
            eprintln!("skipping junction test: could not spawn mklink");
            return;
        };
        if !status.success() {
            if is_ci {
                panic!("mklink refused under CI; junction test must not silently skip");
            }
            eprintln!("skipping junction test: mklink refused (sandbox restriction?)");
            return;
        }
        assert_eq!(
            worktree_is_valid(&repo, &junction).await,
            WorktreeValidity::Valid
        );
    }
}
