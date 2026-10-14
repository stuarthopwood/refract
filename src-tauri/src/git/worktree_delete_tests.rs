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
    let succeeded = matches!(status, Ok(s) if s.success());
    if !succeeded {
        if std::env::var("CI").is_ok() {
            panic!("junction creation failed in CI: mklink /J {link:?} {real_target:?}");
        }
        eprintln!("skipping symlink test: mklink refused (sandbox restriction, not CI)");
        return;
    }
    let result = remove_session_worktree(&repo, &link, "irrelevant", false).await;
    assert!(result.is_err());
    assert!(tokio::fs::metadata(&real_target).await.is_ok());
}

/// A junction living INSIDE the worktrees root (its path lexically "inside" the root, so
/// `assert_within_worktrees_root` reports `Inside` -- it is purely lexical, never resolving the
/// junction) can still redirect a trailing path component to somewhere OUTSIDE the root
/// entirely. `remove_session_worktree` must never let that redirect destroy content living at
/// the junction's real target: with a marker file planted there, the existing "not empty"
/// orphan-folder refusal (the folder's one real entry is `marker.txt`, never `.git` alone)
/// already closes this -- this test locks that behaviour in rather than trusting it by
/// inspection. Skips gracefully outside CI, fails outright in CI (same convention as every
/// other junction test in this crate).
#[tokio::test]
async fn remove_session_worktree_leaves_a_marker_outside_a_junction_planted_inside_the_root() {
    let repo = init_repo().await;
    let root = worktrees_root(&repo);
    tokio::fs::create_dir_all(&root).await.unwrap();
    let outside_target =
        std::env::temp_dir().join(format!("refract-junction-outside-{}", uuid::Uuid::new_v4()));
    let outside_session = outside_target.join("session");
    tokio::fs::create_dir_all(&outside_session).await.unwrap();
    let marker = outside_session.join("marker.txt");
    tokio::fs::write(&marker, b"do not touch").await.unwrap();

    let junction = root.join("junc");
    let status = tokio::process::Command::new("cmd")
        .args([
            "/C",
            "mklink",
            "/J",
            &junction.to_string_lossy(),
            &outside_target.to_string_lossy(),
        ])
        .status()
        .await;
    let succeeded = matches!(status, Ok(s) if s.success());
    if !succeeded {
        if std::env::var("CI").is_ok() {
            panic!("junction creation failed in CI: mklink /J {junction:?} {outside_target:?}");
        }
        eprintln!(
            "skipping junction-inside-root test: mklink refused (sandbox restriction, not CI)"
        );
        return;
    }

    let worktree_path = junction.join("session");
    let result = remove_session_worktree(&repo, &worktree_path, "irrelevant", false).await;
    assert!(
        result.is_err(),
        "a junction-redirected path holding real content must be refused, never silently removed"
    );
    assert!(
        tokio::fs::metadata(&marker).await.is_ok(),
        "the marker file at the junction's real target must survive untouched"
    );
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

/// A `..` built into the path, lexically resolving one level ABOVE the real worktrees root --
/// never silently treated as `Inside` just because the on-the-wire string starts with the
/// root's own path.
#[tokio::test]
async fn assert_within_worktrees_root_refuses_a_dotdot_escape_above_the_root() {
    let repo = init_repo().await;
    let escaping = worktrees_root(&repo)
        .join("..")
        .join(format!("escape-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&escaping).await.unwrap();
    let result = assert_within_worktrees_root(&repo, &escaping).await;
    assert!(!matches!(result, Ok(RootContainment::Inside)));
    assert!(
        result.is_err(),
        "an escaping path that exists must be refused outright, never silently permitted"
    );
}

/// A sibling folder named `<root>-evil` shares a string prefix with the real worktrees root
/// (e.g. if root is `.../pinion-worktrees/pinion` then `.../pinion-worktrees/pinion-evil`) but
/// is NOT nested inside it. This is exactly why the containment check appends
/// `MAIN_SEPARATOR` before its own `starts_with` -- a naive unseparated prefix match would
/// wrongly call this `Inside`.
#[tokio::test]
async fn assert_within_worktrees_root_treats_a_string_prefix_lookalike_sibling_as_outside() {
    let repo = init_repo().await;
    let root = worktrees_root(&repo);
    let lookalike = root.with_file_name(format!(
        "{}-evil",
        root.file_name().unwrap().to_string_lossy()
    ));
    let inside_lookalike = lookalike.join("some-session");
    let result = assert_within_worktrees_root(&repo, &inside_lookalike).await;
    assert!(
        !matches!(result, Ok(RootContainment::Inside)),
        "a naive starts_with on the unseparated string would wrongly treat {} as inside {}",
        inside_lookalike.display(),
        root.display()
    );
}

/// A junction living ABOVE the worktrees root (pointing somewhere unrelated) must not break
/// containment for a real worktree underneath: `comparable_path` is purely lexical (see this
/// crate's own `worktree_validity.rs` header), so it never follows the junction at all. Skips
/// gracefully outside CI (sandbox/non-admin environments commonly refuse junction creation),
/// but fails outright in CI so the loss of coverage is never silent there.
#[tokio::test]
async fn assert_within_worktrees_root_is_unaffected_by_a_junction_above_it() {
    let repo = init_repo().await;
    let root = worktrees_root(&repo);
    tokio::fs::create_dir_all(&root).await.unwrap();
    let junction_target =
        std::env::temp_dir().join(format!("refract-junction-target-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&junction_target).await.unwrap();
    let junction = root
        .parent()
        .unwrap()
        .join(format!("unrelated-junction-{}", uuid::Uuid::new_v4()));
    let status = tokio::process::Command::new("cmd")
        .args([
            "/C",
            "mklink",
            "/J",
            &junction.to_string_lossy(),
            &junction_target.to_string_lossy(),
        ])
        .status()
        .await;
    let succeeded = matches!(status, Ok(s) if s.success());
    if !succeeded {
        if std::env::var("CI").is_ok() {
            panic!("junction creation failed in CI: mklink /J {junction:?} {junction_target:?}");
        }
        eprintln!("skipping junction test: mklink refused (sandbox restriction, not CI)");
        return;
    }
    let real_worktree = root.join("real-session");
    tokio::fs::create_dir_all(&real_worktree).await.unwrap();
    let result = assert_within_worktrees_root(&repo, &real_worktree).await;
    assert!(matches!(result, Ok(RootContainment::Inside)));
}

/// Windows paths are already case-insensitive via `comparable_path`'s own lowercasing: a
/// same-named path differing only in drive-letter case must compare equal.
#[test]
fn comparable_path_is_case_insensitive_for_a_differently_cased_drive_letter() {
    assert_eq!(
        comparable_path("C:/Repos/example/worktree"),
        comparable_path("c:/repos/EXAMPLE/Worktree")
    );
}
