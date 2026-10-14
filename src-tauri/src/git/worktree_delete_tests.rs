// Test module for `worktree_delete.rs`, split into its own file via `#[path = ...]` (same
// pattern `store/registry.rs` uses for `registry_tests.rs`) to keep `worktree_delete.rs` itself
// under the 600-line soft cap.

use super::*;
use crate::git::test_support::init_repo;
use crate::git::worktrees::{add_worktree_with_generated_name, branch_exists};

/// Security-relevant path containment (issue #599/#656): the single gate every removal
/// path below goes through before touching anything.
#[tokio::test]
async fn assert_within_worktrees_root_accepts_a_path_inside_the_root() {
    let repo = init_repo().await;
    let inside = worktrees_root(&repo).join("some-session");
    let result = assert_within_worktrees_root(&repo, &inside).await;
    assert!(matches!(result, Ok(RootContainment::Inside)));
}

#[tokio::test]
async fn assert_within_worktrees_root_reports_outside_missing_for_a_gone_path_elsewhere() {
    let repo = init_repo().await;
    let elsewhere = std::env::temp_dir().join(format!("refract-outside-{}", uuid::Uuid::new_v4()));
    let result = assert_within_worktrees_root(&repo, &elsewhere).await;
    assert!(matches!(result, Ok(RootContainment::OutsideMissing)));
}

/// The critical safety property: a path outside Refract's own worktree folder that EXISTS
/// is refused outright, never silently permitted through to a removal call that could
/// delete someone else's unrelated folder.
#[tokio::test]
async fn assert_within_worktrees_root_refuses_a_path_outside_the_root_that_exists() {
    let repo = init_repo().await;
    let elsewhere =
        std::env::temp_dir().join(format!("refract-outside-exists-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&elsewhere).await.unwrap();
    let result = assert_within_worktrees_root(&repo, &elsewhere).await;
    assert!(
        result.is_err(),
        "a path outside the root that exists must be refused, never silently permitted"
    );
}

#[tokio::test]
async fn remove_session_worktree_removes_a_registered_worktree_and_its_branch() {
    let repo = init_repo().await;
    let added = add_worktree_with_generated_name(&repo, "main")
        .await
        .expect("create worktree");
    remove_session_worktree(&repo, &added.worktree_path, &added.branch, true)
        .await
        .expect("remove");
    assert!(tokio::fs::metadata(&added.worktree_path).await.is_err());
    assert!(!branch_exists(&repo, &added.branch).await);
}

#[tokio::test]
async fn remove_session_worktree_removes_an_unregistered_empty_orphan_folder() {
    let repo = init_repo().await;
    let orphan = worktrees_root(&repo).join("orphan-empty");
    tokio::fs::create_dir_all(&orphan).await.unwrap();
    remove_session_worktree(&repo, &orphan, "branch-that-does-not-exist", false)
        .await
        .expect("remove orphan");
    assert!(tokio::fs::metadata(&orphan).await.is_err());
}

/// Issue #599's own core safety property, proved end to end through the public entry
/// point: a path outside the worktrees root that still exists is refused, and -- the part
/// that actually matters -- nothing inside it is ever touched.
#[tokio::test]
async fn remove_session_worktree_refuses_a_path_outside_the_worktrees_root_that_exists() {
    let repo = init_repo().await;
    let elsewhere =
        std::env::temp_dir().join(format!("refract-outside-delete-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&elsewhere).await.unwrap();
    tokio::fs::write(elsewhere.join("keep-me.txt"), b"do not delete")
        .await
        .unwrap();
    let result = remove_session_worktree(&repo, &elsewhere, "irrelevant", false).await;
    assert!(result.is_err());
    assert!(tokio::fs::metadata(elsewhere.join("keep-me.txt"))
        .await
        .is_ok());
}

#[tokio::test]
async fn remove_session_worktree_refuses_a_symlink_at_the_worktree_path() {
    let repo = init_repo().await;
    let real_target = worktrees_root(&repo).join("real-target");
    tokio::fs::create_dir_all(&real_target).await.unwrap();
    let link = worktrees_root(&repo).join("a-symlink");
    let status = tokio::process::Command::new("cmd")
        .args([
            "/C",
            "mklink",
            "/J",
            &link.to_string_lossy(),
            &real_target.to_string_lossy(),
        ])
        .status()
        .await;
    let Ok(status) = status else {
        eprintln!("skipping symlink test: could not spawn mklink");
        return;
    };
    if !status.success() {
        eprintln!("skipping symlink test: mklink refused (sandbox restriction?)");
        return;
    }
    let result = remove_session_worktree(&repo, &link, "irrelevant", false).await;
    assert!(result.is_err());
    assert!(tokio::fs::metadata(&real_target).await.is_ok());
}

#[tokio::test]
async fn is_registered_but_hand_emptied_true_only_when_git_entry_is_gone() {
    let repo = init_repo().await;
    let added = add_worktree_with_generated_name(&repo, "main")
        .await
        .expect("create worktree");
    assert!(!is_registered_but_hand_emptied(&added.worktree_path)
        .await
        .unwrap());
    tokio::fs::remove_file(added.worktree_path.join(".git"))
        .await
        .unwrap();
    assert!(is_registered_but_hand_emptied(&added.worktree_path)
        .await
        .unwrap());
}
