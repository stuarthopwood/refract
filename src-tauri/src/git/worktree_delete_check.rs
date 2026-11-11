// Decides by asking git, never `fs.stat`, so the delete dialog never under-reports losses.

use std::path::Path;

use serde::Serialize;

use super::git::{git, git_raw, shown_path, GitError, GitErrorCode};
use super::worktree_delete::is_repo_readable;
use super::worktree_validity::is_worktree_registered;
use super::worktrees::branch_exists;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteCheck {
    pub uncommitted_files: i64,
    pub unpushed_commits: i64,
    pub has_upstream: bool,
}

fn zero_risk() -> DeleteCheck {
    DeleteCheck {
        uncommitted_files: 0,
        unpushed_commits: 0,
        has_upstream: true,
    }
}

// Porcelain v1 `XY path`: `D ` (staged delete) and ` D` (worktree delete) are the deletions.
fn is_deleted_status_line(line: &str) -> bool {
    matches!(line.get(..2), Some("D ") | Some(" D"))
}

/// Feeds the delete confirmation text.
pub async fn delete_check(worktree_path: &Path) -> Result<DeleteCheck, GitError> {
    let status = git(worktree_path, &["status", "--porcelain"]).await?;
    // A retry after a partial delete would otherwise count files Refract itself already removed.
    let uncommitted_files = status
        .lines()
        .filter(|l| !l.trim().is_empty() && !is_deleted_status_line(l))
        .count() as i64;

    let upstream = git_raw(
        worktree_path,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        None,
    )
    .await;
    let has_upstream = upstream.code == 0;

    let count_output = git(
        worktree_path,
        &["rev-list", "--count", "HEAD", "--not", "--remotes"],
    )
    .await?;
    let unpushed_commits = count_output.trim().parse::<i64>().unwrap_or(0);

    Ok(DeleteCheck {
        uncommitted_files,
        unpushed_commits,
        has_upstream,
    })
}

/// Delete check for a missing worktree folder: reads `branch`'s commit graph from `repo`.
pub async fn delete_check_for_missing_worktree(
    repo: &Path,
    branch: &str,
) -> Result<DeleteCheck, GitError> {
    if !is_repo_readable(repo).await {
        return Ok(zero_risk());
    }
    if !branch_exists(repo, branch).await {
        return Ok(zero_risk());
    }
    let reference = format!("refs/heads/{branch}");
    let upstream_result = git_raw(
        repo,
        &["for-each-ref", "--format=%(upstream)", "--", &reference],
        None,
    )
    .await;
    let has_upstream = upstream_result.code == 0 && !upstream_result.stdout.trim().is_empty();
    let count_output = git(repo, &["rev-list", "--count", &reference, "--not", "--remotes"])
        .await
        .map_err(|_| {
            GitError::new(
                GitErrorCode::GitFailed,
                format!("Refract could not check branch {branch} for unpushed commits, so it cannot say what Delete would lose. Check the branch in your project at {} before choosing Delete.", shown_path(repo)),
            )
        })?;
    let unpushed_commits = count_output.trim().parse::<i64>().unwrap_or(0);
    Ok(DeleteCheck {
        uncommitted_files: 0,
        unpushed_commits,
        has_upstream,
    })
}

/// Picks the delete check by asking git, never `fs.stat`; bounded by `READER_TIMEOUT` (#1055).
/// On timeout git children are killed on drop, so the read guard is released.
pub async fn delete_check_for_session(
    repo: &Path,
    worktree_path: &Path,
    branch: &str,
) -> Result<DeleteCheck, GitError> {
    tokio::time::timeout(
        crate::fs::worktree_access::READER_TIMEOUT,
        delete_check_for_session_unbounded(repo, worktree_path, branch),
    )
    .await
    .unwrap_or_else(|_| {
        Err(GitError::new(
            GitErrorCode::GitFailed,
            format!("Refract could not check {} in time, so it cannot say what Delete would lose. Close any program that might be slowing git down, then try again.", shown_path(worktree_path)),
        ))
    })
}

async fn delete_check_for_session_unbounded(
    repo: &Path,
    worktree_path: &Path,
    branch: &str,
) -> Result<DeleteCheck, GitError> {
    if !is_repo_readable(repo).await {
        return Ok(zero_risk());
    }
    let has_git_entry = tokio::fs::symlink_metadata(worktree_path.join(".git"))
        .await
        .is_ok();
    if !has_git_entry || !is_worktree_registered(repo, worktree_path).await {
        return delete_check_for_missing_worktree(repo, branch).await;
    }
    let base = delete_check(worktree_path).await?;
    let on_branch = git_raw(worktree_path, &["symbolic-ref", "-q", "HEAD"], None).await;
    if on_branch.code == 0 {
        let scoped = delete_check_for_missing_worktree(repo, branch).await?;
        return Ok(DeleteCheck {
            uncommitted_files: base.uncommitted_files,
            unpushed_commits: scoped.unpushed_commits,
            has_upstream: scoped.has_upstream,
        });
    }
    let branch_still_exists = branch_exists(repo, branch).await;
    let branch_ref = format!("refs/heads/{branch}");
    let mut args: Vec<&str> = vec!["rev-list", "--count", "HEAD"];
    if branch_still_exists {
        args.push(&branch_ref);
    }
    args.push("--not");
    args.push("--remotes");
    let count_output = git(worktree_path, &args).await.map_err(|_| {
        GitError::new(
            GitErrorCode::GitFailed,
            format!("Refract could not check the worktree's detached HEAD for unpushed commits, so it cannot say what Delete would lose. Check {} before choosing Delete.", shown_path(worktree_path)),
        )
    })?;
    let unpushed_commits = count_output.trim().parse::<i64>().unwrap_or(0);
    let has_upstream = if branch_still_exists {
        delete_check_for_missing_worktree(repo, branch)
            .await?
            .has_upstream
    } else {
        true
    };
    Ok(DeleteCheck {
        uncommitted_files: base.uncommitted_files,
        unpushed_commits,
        has_upstream,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::init_repo;
    use crate::git::worktrees::add_worktree_with_generated_name;

    #[tokio::test]
    async fn delete_check_reports_uncommitted_files_and_no_upstream() {
        let repo = init_repo().await;
        let added = add_worktree_with_generated_name(&repo, "main")
            .await
            .expect("create worktree");
        tokio::fs::write(added.worktree_path.join("new.txt"), b"hi")
            .await
            .unwrap();
        let check = delete_check(&added.worktree_path).await.unwrap();
        assert_eq!(check.uncommitted_files, 1);
        // With no remote, `--not --remotes` excludes nothing, so the seed commit counts as unpushed.
        assert_eq!(check.unpushed_commits, 1);
        assert!(!check.has_upstream);
    }

    #[tokio::test]
    async fn delete_check_excludes_staged_and_worktree_delete_lines_from_uncommitted_files() {
        let repo = init_repo().await;
        let added = add_worktree_with_generated_name(&repo, "main")
            .await
            .expect("create worktree");
        tokio::fs::remove_file(added.worktree_path.join("README.md"))
            .await
            .unwrap();
        assert_eq!(
            delete_check(&added.worktree_path)
                .await
                .unwrap()
                .uncommitted_files,
            0
        );
        crate::git::test_support::run_git(
            &added.worktree_path,
            &["rm", "-q", "--cached", "README.md"],
        )
        .await;
        assert_eq!(
            delete_check(&added.worktree_path)
                .await
                .unwrap()
                .uncommitted_files,
            0
        );
    }

    #[tokio::test]
    async fn delete_check_for_missing_worktree_is_zero_risk_when_branch_is_already_gone() {
        let repo = init_repo().await;
        let check = delete_check_for_missing_worktree(&repo, "never-existed")
            .await
            .unwrap();
        assert_eq!(check.unpushed_commits, 0);
        assert!(
            check.has_upstream,
            "nothing left to warn about reports has_upstream true"
        );
    }

    #[tokio::test]
    async fn delete_check_for_session_falls_back_to_branch_graph_when_worktree_folder_is_gone() {
        let repo = init_repo().await;
        let added = add_worktree_with_generated_name(&repo, "main")
            .await
            .expect("create worktree");
        let worktree_path = added.worktree_path.clone();
        let branch = added.branch.clone();
        tokio::fs::remove_dir_all(&worktree_path).await.unwrap();
        let check = delete_check_for_session(&repo, &worktree_path, &branch)
            .await
            .unwrap();
        assert_eq!(check.uncommitted_files, 0);
        assert_eq!(check.unpushed_commits, 1);
    }

    #[tokio::test]
    async fn delete_check_for_session_is_zero_risk_when_the_repository_is_unreadable() {
        let missing_repo =
            crate::test_scratch::path(format!("refract-no-such-repo-{}", uuid::Uuid::new_v4()));
        let check =
            delete_check_for_session(&missing_repo, &missing_repo.join("worktree"), "irrelevant")
                .await
                .unwrap();
        assert_eq!(check.uncommitted_files, 0);
        assert_eq!(check.unpushed_commits, 0);
        assert!(check.has_upstream);
    }
}
