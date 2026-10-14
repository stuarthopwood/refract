// Issue #729 (folded into lane R2, #785): "a single `worktree_is_valid()` (registered with git
// AND has its own `.git` pointer, not merely `exists()`) used by agent start, open and the
// Explorer; an invalid worktree reports `worktree-missing` and the Recreate action warns that
// unpushed work is lost." Electron's `worktrees.ts` has no single function with this exact
// contract -- `SessionManager.ts`/`fileExplorer.ts` each ran their own ad hoc `fs.stat` check
// (the bug #729 describes: a folder that still exists but whose `.git` pointer was hand-deleted,
// or one git no longer has registered, both read as present). This is the corrected replacement,
// public so lane R7 (#790, File Explorer) reuses the exact same check rather than another ad hoc
// `fs.stat`. Its signature is `pub async fn worktree_is_valid(repo: &Path, worktree_path: &Path)
// -> WorktreeValidity` (see gate round 1 remediation below).
//
// Gate round 1 remediation (PR #826): `worktree_is_valid` used to return a plain `bool`,
// collapsing "confirmed invalid" and "could not tell because git timed out or failed" into the
// same `false` -- a slow disk or antivirus scan stalling `git worktree list` would wrongly report
// a perfectly healthy Session as `worktree-missing`. It now returns a 3-state `WorktreeValidity`
// (see its own doc comment); callers decide separately how to treat `Unknown`
// (`session::manager::summaries()` treats it the same as `Valid`, see its own comment).
//
// Path comparisons also used to be LEXICAL only (resolve `.`/`..`, lowercase, platform
// separator), the same simplification `store::registry`'s own `same_path`/`resolve_path_lexical`
// already makes for comparing a worktree path that may not exist yet -- but a worktree reached
// only through a directory junction (a normal way Windows worktree folders can be aliased; pnpm
// itself uses junctions) was wrongly reported invalid, which is real production behaviour this
// Windows-only build needs to get right. Both the candidate path and every path `git worktree
// list --porcelain` reports are now resolved through `dunce::canonicalize` first (falling back to
// the lexical path on failure, e.g. a path that does not exist on disk) before the lexical
// `comparable_path` compare.

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::git::git;

/// How long `git worktree list --porcelain` may run before this module gives up waiting and
/// reports `WorktreeValidity::Unknown` (or `None` from `list_registered_worktrees`) instead of
/// blocking its caller indefinitely on a stalled git process (slow disk, antivirus scan, ...).
/// Gate round 1 (#826): a repository with many Sessions now shares ONE of these calls across
/// every Session (`list_registered_worktrees`, reused by `session::manager::summaries()`'s
/// batched path), so this timeout bounds that single shared call, not a per-Session one.
const REGISTRY_CHECK_TIMEOUT: Duration = Duration::from_secs(3);

/// Issue #729's valid/invalid plus gate round 1's third state. `Unknown` means the underlying
/// `git worktree list --porcelain` call could not be made to settle within
/// `REGISTRY_CHECK_TIMEOUT` -- NOT folded into `Invalid`: a slow git call must never be read as a
/// confirmed-missing worktree. A missing `.git` entry is still a fast, confident `Invalid` (a
/// plain `symlink_metadata` check against the local folder, no git call and so no timeout
/// involved).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorktreeValidity {
    Valid,
    Invalid,
    Unknown,
}

/// Case- and separator-insensitive comparison key for a filesystem path, without touching disk
/// (mirrors `store::registry`'s private `same_path`/`resolve_path_lexical` pair, duplicated here
/// rather than exported across the `git`/`store` module boundary for one small pure function).
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

/// Resolves `p` through `dunce::canonicalize` (a `\\?\`-free canonical path on Windows,
/// resolving directory junctions/symlinks) before the lexical `comparable_path` compare, so a
/// worktree reached only through a junction alias is recognised as the SAME registered worktree a
/// `git worktree list --porcelain` entry reports under its real path. Falls back to the
/// uncanonicalized path on failure (the path may not exist on disk, e.g. a relative gitdir
/// record that is itself a relative reference) rather than erroring out. Runs on a blocking-pool
/// thread since `dunce::canonicalize` is a synchronous filesystem call.
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

/// Parses `git worktree list --porcelain` output into each entry's own `worktree <path>` line
/// (the only line this module needs; branch/HEAD/locked lines are irrelevant here).
pub(crate) fn parse_porcelain_worktree_paths(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .map(str::to_string)
        .collect()
}

/// Runs `git worktree list --porcelain` for `repo` ONCE and returns every registered worktree's
/// canonicalized comparison key (`canonical_comparable_path`). `None` means the call could not be
/// made to settle within `REGISTRY_CHECK_TIMEOUT` -- a confirmed git failure (not a repo, etc)
/// still returns `Some(vec![])`, since that IS a settled answer ("nothing is registered"), just
/// not a timeout.
///
/// Gate round 1 HIGH perf finding: `session::manager::summaries()` calls this exactly once per
/// distinct repository with at least one agent-less Session, not once per Session -- a
/// repository with many Sessions no longer re-lists the same worktrees over and over serially.
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

/// True when git itself still has `worktree_path` registered as one of `repo`'s worktrees. A
/// timed-out `list_registered_worktrees` call maps to `false` here, preserving this function's
/// existing bool contract for its one external caller
/// (`worktree_delete_check::delete_check_for_session`) -- a confirmed registration could not be
/// verified in time, so it falls back to the same safe-delete-check path a genuinely
/// unregistered worktree would take.
pub(crate) async fn is_worktree_registered(repo: &Path, worktree_path: &Path) -> bool {
    let target = canonical_comparable_path(worktree_path).await;
    list_registered_worktrees(repo)
        .await
        .is_some_and(|list| list.contains(&target))
}

/// Shared tail of `worktree_is_valid` (single-worktree path, fetches its own list) and
/// `session::manager::summaries()`'s batched path (passes in a list already fetched once per
/// repository, shared across every Session in it): given the registered-worktree list (or `None`
/// for a timed-out fetch), decides Valid/Invalid/Unknown for one worktree whose `.git` entry is
/// already confirmed present by the caller.
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

/// Issue #729: valid means git still recognises `worktree_path` as a registered worktree of
/// `repo` AND the folder still has its own `.git` entry (a file for a linked worktree) -- not
/// merely `exists()`, which a hand-emptied folder (registered, but its `.git` pointer deleted)
/// or an orphaned leftover (folder present, git already lost track of it) both satisfy while
/// being unusable. Used today by `session::manager::summaries()`'s registry-only `stopReason`
/// computation; lane R3/#786 (agent start/open) and lane R7/#790 (File Explorer) must wire this
/// in too, reporting `worktree-missing` instead of silently treating either state as healthy --
/// `WorktreeValidity::Unknown` (a timed-out check) must never be read as confirmed-missing by
/// either caller. Gate round 1 (#826): returns `WorktreeValidity`, not a `bool`.
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
        // Has a `.git` FILE, but no `git worktree add` ever created it -- registered is false.
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
        // Still registered with git (nothing told git), but no `.git` entry remains -- exactly
        // the state issue #729 describes a plain `exists()` check wrongly reports as healthy.
        assert_eq!(
            worktree_is_valid(&repo, &added.worktree_path).await,
            WorktreeValidity::Invalid
        );
    }

    /// Documents this file's own corrected contract (see header, gate round 1 #826): a worktree
    /// reached only through a directory junction alias IS recognised as the SAME registered
    /// worktree `git worktree list` reports under its real path (junctions are a normal way
    /// Windows worktree folders can be reached -- pnpm itself uses them). Only a genuinely
    /// local/sandboxed dev run that cannot create a junction at all may skip; under CI (`CI` is
    /// set -- GitHub Actions' own default, see `.github/workflows/ci.yml`) a failure to create
    /// the junction is a test FAILURE, not a silent pass, so a sandbox/toolchain regression can
    /// never masquerade as green CI.
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
