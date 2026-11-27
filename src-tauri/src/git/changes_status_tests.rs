// Tests for the stage / unstage / commit half of `changes_status.rs`, against real temp repos.

use super::*;
use crate::git::test_support::init_repo;

async fn git_out(repo: &Path, args: &[&str]) -> String {
    let result = git_raw(repo, args, None).await;
    assert_eq!(result.code, 0, "git {args:?}: {}", result.stderr);
    result.stdout
}

/// Paths currently in the index that differ from HEAD, NUL-split so odd names stay intact.
async fn staged_paths(repo: &Path) -> Vec<String> {
    git_out(repo, &["diff", "--cached", "--name-only", "-z"])
        .await
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect()
}

async fn write(repo: &Path, relative: &str, content: &str) {
    let path = repo.join(relative);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.unwrap();
    }
    tokio::fs::write(path, content).await.unwrap();
}

#[tokio::test]
async fn staging_paths_with_spaces_and_non_ascii_names_stages_exactly_those() {
    let repo = init_repo().await;
    write(&repo, "my notes/a b.txt", "one\n").await;
    write(&repo, "naïve.txt", "two\n").await;
    write(&repo, "other.txt", "not staged\n").await;

    stage_files(
        &repo,
        &["my notes/a b.txt".to_string(), "naïve.txt".to_string()],
    )
    .await
    .expect("stage");

    let mut staged = staged_paths(&repo).await;
    staged.sort();
    assert_eq!(staged, ["my notes/a b.txt", "naïve.txt"]);
}

#[tokio::test]
async fn a_deleted_file_can_be_staged_as_a_deletion() {
    let repo = init_repo().await;
    tokio::fs::remove_file(repo.join("README.md"))
        .await
        .unwrap();

    stage_files(&repo, &["README.md".to_string()])
        .await
        .expect("stage deletion");

    let status = git_out(&repo, &["diff", "--cached", "--name-status"]).await;
    assert_eq!(status.trim(), "D\tREADME.md");
}

#[tokio::test]
async fn glob_characters_in_a_name_are_taken_literally() {
    let repo = init_repo().await;
    write(&repo, "[x].txt", "bracketed\n").await;
    write(&repo, "x.txt", "plain\n").await;

    stage_files(&repo, &["[x].txt".to_string()])
        .await
        .expect("stage");

    assert_eq!(staged_paths(&repo).await, ["[x].txt"]);
}

#[tokio::test]
async fn empty_lists_never_reach_git() {
    // A directory that is not a repo: any git call would fail, so Ok proves none was made.
    let not_a_repo = crate::test_scratch::path(format!("refract-no-repo-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&not_a_repo).await.unwrap();

    assert!(stage_files(&not_a_repo, &[]).await.is_ok());
    assert!(unstage_files(&not_a_repo, &[]).await.is_ok());
}

#[tokio::test]
async fn unstaging_keeps_the_edit_in_the_working_tree() {
    let repo = init_repo().await;
    write(&repo, "README.md", "edited\n").await;
    stage_files(&repo, &["README.md".to_string()])
        .await
        .unwrap();
    assert_eq!(staged_paths(&repo).await, ["README.md"]);

    unstage_files(&repo, &["README.md".to_string()])
        .await
        .expect("unstage");

    assert!(staged_paths(&repo).await.is_empty());
    let on_disk = tokio::fs::read_to_string(repo.join("README.md"))
        .await
        .unwrap();
    assert_eq!(on_disk, "edited\n", "unstage must never discard the edit");
}

#[tokio::test]
async fn unsafe_paths_are_refused_before_git_runs_and_stage_nothing() {
    let repo = init_repo().await;
    write(&repo, "fine.txt", "ok\n").await;

    let escaped = stage_files(
        &repo,
        &["fine.txt".to_string(), "../outside.txt".to_string()],
    )
    .await
    .expect_err("a path outside the worktree");
    let option_like = unstage_files(&repo, &["--all".to_string()])
        .await
        .expect_err("an option-shaped path");

    assert_eq!(escaped.code, GitErrorCode::OutsideWorktree);
    assert_eq!(option_like.code, GitErrorCode::OutsideWorktree);
    assert!(
        staged_paths(&repo).await.is_empty(),
        "the valid path in a refused batch must not be staged"
    );
}

#[tokio::test]
async fn commit_records_a_multi_line_message_and_only_the_staged_files() {
    let repo = init_repo().await;
    write(&repo, "staged.txt", "in\n").await;
    write(&repo, "left-out.txt", "out\n").await;
    stage_files(&repo, &["staged.txt".to_string()])
        .await
        .unwrap();

    commit(
        &repo,
        "Add staged file\n\nBody with \"quotes\" and 100% of it.",
    )
    .await
    .expect("commit");

    let message = git_out(&repo, &["log", "-1", "--format=%B"]).await;
    assert_eq!(
        message.trim(),
        "Add staged file\n\nBody with \"quotes\" and 100% of it."
    );
    let committed = git_out(&repo, &["show", "--name-only", "--format=", "HEAD"]).await;
    assert_eq!(committed.trim(), "staged.txt");
    let untracked = git_out(&repo, &["ls-files", "--others", "--exclude-standard"]).await;
    assert_eq!(untracked.trim(), "left-out.txt");
}

#[tokio::test]
async fn committing_with_nothing_staged_reports_git_failed() {
    let repo = init_repo().await;

    let err = commit(&repo, "empty").await.expect_err("nothing to commit");

    assert_eq!(err.code, GitErrorCode::GitFailed);
    assert!(err.message.contains("git"), "{}", err.message);
}
