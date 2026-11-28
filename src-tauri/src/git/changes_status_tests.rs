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

async fn summary_of(repo: &Path) -> DiffStatResult {
    let snapshot = read_changes_status(repo, "main")
        .await
        .expect("snapshot of a real repo");
    changes_summary(&snapshot)
}

#[tokio::test]
async fn a_clean_tree_summarises_to_zero_files() {
    let repo = init_repo().await;

    let summary = summary_of(&repo).await;

    assert_eq!(
        (summary.files, summary.additions, summary.deletions),
        (0, 0, 0)
    );
    assert!(!summary.partial);
}

#[tokio::test]
async fn staged_unstaged_and_untracked_rows_each_count() {
    let repo = init_repo().await;
    write(&repo, "staged.txt", "one\ntwo\n").await;
    stage_files(&repo, &["staged.txt".to_string()])
        .await
        .unwrap();
    write(&repo, "README.md", "edited\n").await;
    write(&repo, "untracked.txt", "a\nb\nc\n").await;

    let summary = summary_of(&repo).await;

    assert_eq!(summary.files, 3);
    assert_eq!(summary.additions, 2 + 1 + 3);
    assert_eq!(summary.deletions, 1);
    assert!(!summary.partial);
}

#[tokio::test]
async fn a_partially_staged_path_counts_once() {
    let repo = init_repo().await;
    write(&repo, "README.md", "first edit\n").await;
    stage_files(&repo, &["README.md".to_string()])
        .await
        .unwrap();
    write(&repo, "README.md", "second edit\n").await;

    let snapshot = read_changes_status(&repo, "main").await.unwrap();
    assert_eq!(snapshot.groups.staged.len(), 1);
    assert_eq!(snapshot.groups.changes.len(), 1);

    assert_eq!(changes_summary(&snapshot).files, 1);
}

#[tokio::test]
async fn a_deleted_file_counts() {
    let repo = init_repo().await;
    tokio::fs::remove_file(repo.join("README.md"))
        .await
        .unwrap();

    let summary = summary_of(&repo).await;

    assert_eq!((summary.files, summary.deletions), (1, 1));
}

#[tokio::test]
async fn a_conflicted_path_counts() {
    let repo = init_repo().await;
    git_out(&repo, &["checkout", "-q", "-b", "other"]).await;
    write(&repo, "README.md", "other side\n").await;
    git_out(&repo, &["commit", "-q", "-am", "other"]).await;
    git_out(&repo, &["checkout", "-q", "main"]).await;
    write(&repo, "README.md", "main side\n").await;
    git_out(&repo, &["commit", "-q", "-am", "main"]).await;
    let merge = git_raw(&repo, &["merge", "other"], None).await;
    assert_ne!(merge.code, 0, "the merge must conflict");

    let snapshot = read_changes_status(&repo, "main").await.unwrap();

    assert_eq!(snapshot.groups.conflicts.len(), 1);
    assert_eq!(changes_summary(&snapshot).files, 1);
}

#[tokio::test]
async fn more_than_the_cap_of_rows_is_partial_with_the_cap_unchanged() {
    let repo = init_repo().await;
    for i in 0..=MAX_FILES {
        write(&repo, &format!("bulk/f{i:03}.txt"), "x\n").await;
    }

    let snapshot = read_changes_status(&repo, "main").await.unwrap();
    let summary = changes_summary(&snapshot);

    assert_eq!(MAX_FILES, 200);
    assert!(summary.partial);
    assert_eq!(summary.files, MAX_FILES as i64 + 1);
    assert_eq!(
        summary.additions, MAX_FILES as i64,
        "the skipped row adds 0"
    );
}

#[test]
fn exactly_the_cap_of_rows_is_not_partial() {
    let rows: Vec<GitChangesFileEntry> = (0..MAX_FILES)
        .map(|i| GitChangesFileEntry {
            path: format!("f{i}.txt"),
            folder: String::new(),
            mark: GitStatusMark::Untracked,
            additions: 1,
            deletions: 0,
            partial: false,
        })
        .collect();
    let snapshot = GitChangesSnapshot {
        header: GitChangesHeader {
            branch: "main".to_string(),
            base_branch: "main".to_string(),
            ahead_behind: None,
        },
        groups: GitChangesGroups {
            untracked: rows,
            ..GitChangesGroups::default()
        },
    };

    let summary = changes_summary(&snapshot);

    assert_eq!(summary.files, 200);
    assert!(!summary.partial);
}

#[test]
fn an_oversized_file_row_does_not_make_the_count_partial() {
    let snapshot = GitChangesSnapshot {
        header: GitChangesHeader {
            branch: "main".to_string(),
            base_branch: "main".to_string(),
            ahead_behind: None,
        },
        groups: GitChangesGroups {
            untracked: vec![GitChangesFileEntry {
                path: "huge.log".to_string(),
                folder: String::new(),
                mark: GitStatusMark::Untracked,
                additions: 0,
                deletions: 0,
                partial: true,
            }],
            ..GitChangesGroups::default()
        },
    };

    let summary = changes_summary(&snapshot);

    assert_eq!(summary.files, 1);
    assert!(!summary.partial);
}
