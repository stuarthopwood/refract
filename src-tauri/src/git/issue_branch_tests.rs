// Tests for `issue_branch.rs`: the branch name a Session started from an issue gets, and what
// happens when that name is already taken.

use super::*;
use crate::git::test_support::{init_repo, run_git};
use crate::git::worktrees::{branch_exists, worktrees_root};

#[test]
fn slug_collapses_punctuation_and_lowercases() {
    assert_eq!(title_slug("Fix: the  login--bug!!"), "fix-the-login-bug");
}

#[test]
fn slug_drops_non_ascii_letters_instead_of_keeping_them() {
    assert_eq!(title_slug("Überprüfung der Größe"), "berpr-fung-der-gr-e");
}

#[test]
fn slug_cut_at_the_cap_never_ends_in_a_dash() {
    let title = format!("{} b", "a".repeat(39));
    assert_eq!(title_slug(&title), "a".repeat(39));
}

#[test]
fn a_title_with_no_ascii_words_falls_back_to_the_bare_issue_number() {
    assert_eq!(issue_branch_name(9, "🔥 ❓"), "issue-9");
    assert_eq!(
        issue_branch_name(9, "Crash on start"),
        "issue-9-crash-on-start"
    );
}

#[tokio::test]
async fn a_new_issue_gets_its_named_branch_and_a_checked_out_worktree() {
    let repo = init_repo().await;

    let added = add_worktree_for_issue(&repo, 7, "Fix the login bug")
        .await
        .expect("create issue worktree");

    assert_eq!(added.branch, "issue-7-fix-the-login-bug");
    assert!(branch_exists(&repo, &added.branch).await);
    assert!(
        added.worktree_path.join("README.md").is_file(),
        "the worktree must hold the base branch's files"
    );
}

#[tokio::test]
async fn a_taken_branch_name_gets_the_next_free_suffix() {
    let repo = init_repo().await;
    run_git(&repo, &["branch", "issue-7-fix-login"]).await;

    let second = add_worktree_for_issue(&repo, 7, "Fix login")
        .await
        .expect("second start on the same issue");
    let third = add_worktree_for_issue(&repo, 7, "Fix login")
        .await
        .expect("third start on the same issue");

    assert_eq!(second.branch, "issue-7-fix-login-2");
    assert_eq!(third.branch, "issue-7-fix-login-3");
    assert_ne!(second.worktree_path, third.worktree_path);
}

#[tokio::test]
async fn a_leftover_folder_under_the_base_name_is_skipped_and_left_untouched() {
    let repo = init_repo().await;
    let leftover = worktrees_root(&repo).join("issue-4-flaky-test");
    tokio::fs::create_dir_all(&leftover).await.unwrap();
    tokio::fs::write(leftover.join("keep.txt"), b"mine")
        .await
        .unwrap();

    let added = add_worktree_for_issue(&repo, 4, "Flaky test")
        .await
        .expect("start with a leftover folder");

    assert_eq!(added.branch, "issue-4-flaky-test-2");
    assert!(leftover.join("keep.txt").is_file());
}
