// Test module for `worktrees.rs`, split into its own file via `#[path = ...]` (same convention
// `store/registry.rs` -> `registry_tests.rs` and `git/worktree_delete.rs` ->
// `worktree_delete_tests.rs` already use) to keep `worktrees.rs` itself under the 600-line soft
// cap.

use super::*;
use crate::git::test_support::init_repo;

#[tokio::test]
async fn creates_a_worktree_with_a_freshly_generated_unique_name() {
    let repo = init_repo().await;
    let added = add_worktree_with_generated_name(&repo, "main")
        .await
        .expect("create worktree");
    assert!(tokio::fs::metadata(&added.worktree_path)
        .await
        .expect("worktree dir exists")
        .is_dir());
    assert!(!added.branch.is_empty());
    assert!(branch_exists(&repo, &added.branch).await);
}

/// Issue #656 regression lock: two sequential creates against the same repository never
/// pick the same name, and neither call's own failure-cleanup (had it raced the other's
/// name) ever removes artefacts the OTHER call owns.
#[tokio::test]
async fn two_sequential_creates_never_collide_and_both_keep_their_own_worktree() {
    let repo = init_repo().await;
    let first = add_worktree_with_generated_name(&repo, "main")
        .await
        .expect("first create");
    let second = add_worktree_with_generated_name(&repo, "main")
        .await
        .expect("second create");
    assert_ne!(first.branch, second.branch);
    assert_ne!(first.worktree_path, second.worktree_path);
    assert!(tokio::fs::metadata(&first.worktree_path).await.is_ok());
    assert!(tokio::fs::metadata(&second.worktree_path).await.is_ok());
    assert!(branch_exists(&repo, &first.branch).await);
    assert!(branch_exists(&repo, &second.branch).await);
}

#[tokio::test]
async fn rejects_a_missing_base_branch_without_creating_anything() {
    let repo = init_repo().await;
    let err = add_worktree_with_generated_name(&repo, "does-not-exist")
        .await
        .expect_err("missing base branch must fail");
    assert_eq!(err.code, GitErrorCode::BaseMissing);
    let still_empty = tokio::fs::read_dir(worktrees_root(&repo)).await;
    if let Ok(mut entries) = still_empty {
        assert!(entries.next_entry().await.unwrap().is_none());
    }
    // No stray branch reservation survives a rejected attempt either.
    assert_eq!(
        list_branches(&repo).await.unwrap(),
        vec!["main".to_string()]
    );
}

/// Gate round 1, HIGH #656: a pre-existing folder (nothing to do with this attempt's own
/// branch reservation) is detected via `AlreadyExists` and never touched -- not deleted,
/// not descended into -- and the attempt's own branch reservation is cleaned up instead.
#[tokio::test]
async fn try_reserve_and_create_collision_on_a_pre_existing_folder_leaves_it_untouched() {
    let repo = init_repo().await;
    let candidate = "pre-existing-name";
    let path = worktrees_root(&repo).join(candidate);
    tokio::fs::create_dir_all(&path).await.unwrap();
    let marker = path.join("marker.txt");
    tokio::fs::write(&marker, b"do not touch").await.unwrap();

    let outcome = try_reserve_and_create(&repo, "main", candidate)
        .await
        .expect("a folder collision is not a hard error");
    assert!(matches!(outcome, CandidateOutcome::Collision));
    assert!(
        !branch_exists(&repo, candidate).await,
        "the reservation this attempt made must be cleaned up"
    );
    assert!(
        tokio::fs::metadata(&marker).await.is_ok(),
        "a folder this attempt never created must never be touched"
    );
}

/// Gate round 1, HIGH #656 regression lock: using the test-only candidate seam, force an
/// attempt to collide on a name a real concurrent "winner" already fully created (branch +
/// worktree + a file inside it), then fall back to a fresh name. The winner's branch,
/// worktree and the file inside it must all survive untouched.
#[tokio::test]
async fn a_create_skips_a_colliding_candidate_and_never_touches_the_winners_artifacts() {
    let repo = init_repo().await;
    let winner = add_worktree_with_generated_name(&repo, "main")
        .await
        .expect("create the 'winning' worktree");
    let marker = winner.worktree_path.join("marker.txt");
    tokio::fs::write(&marker, b"winner's file").await.unwrap();

    let fresh_name = format!("fresh-{}", uuid::Uuid::new_v4().simple());
    let candidates = vec![winner.branch.clone(), fresh_name];
    let ours = add_worktree_with_candidates(&repo, "main", candidates)
        .await
        .expect("falls back to the fresh candidate");

    assert_ne!(ours.branch, winner.branch);
    assert!(
        tokio::fs::metadata(&marker).await.is_ok(),
        "the winner's marker file must survive untouched"
    );
    assert!(
        branch_exists(&repo, &winner.branch).await,
        "the winner's branch must survive"
    );
    assert!(
        tokio::fs::metadata(&winner.worktree_path).await.is_ok(),
        "the winner's worktree must survive"
    );
}

/// Gate round 3, HIGH #656 regression lock (reopened by the PR-worktree path):
/// `add_worktree_from_pull_request_branch` generates the exact deterministic `pr-<n>`,
/// `pr-<n>-2`, ... sequence under test here via `add_worktree_with_candidates` -- the same
/// engine it calls in production, just with its real network fetch skipped (an existing local
/// branch stands in for the fetched commit). Simulates two concurrent
/// `newSessionFromPullRequest` calls for the SAME pull request number both settling on
/// `pr-<n>`: the winner creates it first (branch, worktree, and a marker file inside); a loser
/// forced to retry the identical sequence must skip straight to `pr-<n>-2` and leave every one
/// of the winner's artefacts completely untouched -- the bug this round fixed had the loser's
/// own cleanup `git worktree remove --force` + `branch -D` the WINNER's name instead.
#[tokio::test]
async fn a_concurrent_pr_worktree_create_skips_the_winners_pr_branch_and_never_touches_it() {
    let repo = init_repo().await;
    let number = 999u64;
    let base = format!("pr-{number}");

    let winner = add_worktree_with_candidates(&repo, "main", vec![base.clone()])
        .await
        .expect("create the 'winning' pr-999 worktree");
    assert_eq!(winner.branch, base);
    let marker = winner.worktree_path.join("marker.txt");
    tokio::fs::write(&marker, b"winner's file").await.unwrap();

    // The exact candidate sequence `add_worktree_from_pull_request_branch` itself generates for
    // the same pull request number: `pr-999`, `pr-999-2`, `pr-999-3`, ...
    let candidates = std::iter::once(base.clone()).chain((2..=5u32).map(|n| format!("{base}-{n}")));
    let loser = add_worktree_with_candidates(&repo, "main", candidates)
        .await
        .expect("falls back to pr-999-2");

    assert_eq!(loser.branch, format!("{base}-2"));
    assert!(
        tokio::fs::metadata(&marker).await.is_ok(),
        "the winner's marker file must survive untouched"
    );
    assert!(
        branch_exists(&repo, &winner.branch).await,
        "the winner's pr-999 branch must survive"
    );
    assert!(
        tokio::fs::metadata(&winner.worktree_path).await.is_ok(),
        "the winner's pr-999 worktree must survive"
    );
}

#[test]
fn is_branch_exists_error_recognises_gits_own_wording() {
    assert!(is_branch_exists_error(
        "fatal: a branch named 'foo' already exists"
    ));
    assert!(is_branch_exists_error(
        "fatal: cannot lock ref 'refs/heads/foo': unable to resolve reference"
    ));
    assert!(!is_branch_exists_error(
        "fatal: not a valid object name: 'bogus'"
    ));
}

#[test]
fn map_add_worktree_error_recognises_base_missing_wording() {
    let err = map_add_worktree_error(
        "fatal: invalid reference: bogus",
        Path::new("C:/scratch/worktree"),
    );
    assert_eq!(err.code, GitErrorCode::BaseMissing);
}

#[test]
fn map_add_worktree_error_recognises_path_too_long_wording() {
    let err = map_add_worktree_error(
        "fatal: unable to create file (file name too long)",
        Path::new("C:/scratch/worktree"),
    );
    assert_eq!(err.code, GitErrorCode::PathTooLong);
}

#[tokio::test]
async fn recreate_worktree_reattaches_an_existing_branch_after_the_folder_is_removed() {
    let repo = init_repo().await;
    let added = add_worktree_with_generated_name(&repo, "main")
        .await
        .expect("create worktree");
    remove_worktree(&repo, &added.worktree_path, &added.branch, false)
        .await
        .expect("remove worktree, keep branch");
    assert!(tokio::fs::metadata(&added.worktree_path).await.is_err());
    recreate_worktree(&repo, &added.worktree_path, &added.branch)
        .await
        .expect("recreate");
    assert!(tokio::fs::metadata(&added.worktree_path)
        .await
        .expect("recreated worktree exists")
        .is_dir());
}
