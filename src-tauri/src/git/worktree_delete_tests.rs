// Split from `worktree_delete.rs` via `#[path]` to keep it under the 600-line soft cap.

use super::*;
use crate::git::test_support::init_repo;
use crate::git::worktrees::{add_worktree_with_generated_name, branch_exists};

/// Path containment is the single gate before any removal (#599/#656).
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
    let elsewhere = crate::test_scratch::path(format!("refract-outside-{}", uuid::Uuid::new_v4()));
    let result = assert_within_worktrees_root(&repo, &elsewhere).await;
    assert!(matches!(result, Ok(RootContainment::OutsideMissing)));
}

/// An existing path outside the worktrees folder is refused, never deleted.
#[tokio::test]
async fn assert_within_worktrees_root_refuses_a_path_outside_the_root_that_exists() {
    let repo = init_repo().await;
    let elsewhere =
        crate::test_scratch::path(format!("refract-outside-exists-{}", uuid::Uuid::new_v4()));
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

/// Outside path that still exists is refused end to end and nothing inside it is touched (#599).
#[tokio::test]
async fn remove_session_worktree_refuses_a_path_outside_the_worktrees_root_that_exists() {
    let repo = init_repo().await;
    let elsewhere =
        crate::test_scratch::path(format!("refract-outside-delete-{}", uuid::Uuid::new_v4()));
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

/// A junction inside the root can redirect outside it; `remove_tree` canonicalizes and refuses,
/// so the junction target's content survives. Skips outside CI, fails in CI.
#[tokio::test]
async fn remove_session_worktree_leaves_a_marker_outside_a_junction_planted_inside_the_root() {
    let repo = init_repo().await;
    let root = worktrees_root(&repo);
    tokio::fs::create_dir_all(&root).await.unwrap();
    let outside_target =
        crate::test_scratch::path(format!("refract-junction-outside-{}", uuid::Uuid::new_v4()));
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

/// A registered worktree whose `.git` pointer file was hand-removed is still fully removed
/// (folder and admin entry).
#[tokio::test]
async fn remove_session_worktree_deletes_a_hand_emptied_registered_worktree_and_its_admin_entry() {
    let repo = init_repo().await;
    let added = add_worktree_with_generated_name(&repo, "main")
        .await
        .expect("create worktree");
    tokio::fs::remove_file(added.worktree_path.join(".git"))
        .await
        .unwrap();

    let result = remove_session_worktree(&repo, &added.worktree_path, "irrelevant", false).await;
    assert!(result.is_ok(), "{result:?}");
    assert!(
        tokio::fs::metadata(&added.worktree_path).await.is_err(),
        "the hand-emptied worktree's own folder must be gone"
    );
    assert!(
        !is_worktree_registered(&repo, &added.worktree_path).await,
        "its admin entry must be gone too -- `git worktree list --porcelain` must no longer list it"
    );
}

/// A `..` escaping the root is never treated as `Inside` despite the matching string prefix.
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

/// A sibling `<root>-evil` shares a string prefix but is not inside the root; the check appends
/// `MAIN_SEPARATOR` before `starts_with` for exactly this reason.
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

/// A junction above the root must not break containment (the check is lexical). Skips outside
/// CI, since sandboxes often refuse junction creation; fails in CI.
#[tokio::test]
async fn assert_within_worktrees_root_is_unaffected_by_a_junction_above_it() {
    let repo = init_repo().await;
    let root = worktrees_root(&repo);
    tokio::fs::create_dir_all(&root).await.unwrap();
    let junction_target =
        crate::test_scratch::path(format!("refract-junction-target-{}", uuid::Uuid::new_v4()));
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

/// Drive-letter case differences compare equal (`comparable_path` lowercases).
#[test]
fn comparable_path_is_case_insensitive_for_a_differently_cased_drive_letter() {
    assert_eq!(
        comparable_path("C:/Repos/example/worktree"),
        comparable_path("c:/repos/EXAMPLE/Worktree")
    );
}

#[test]
fn path_changed_on_retry_maps_to_a_refusal_naming_the_pinned_path() {
    let err = map_remove_tree_error(
        RemoveTreeError::PathChanged {
            path: std::path::PathBuf::from("C:/w/pinned"),
        },
        Path::new("C:/w/s1"),
    );
    assert!(
        err.message.contains("resolved to a different folder"),
        "{}",
        err.message
    );
    assert!(err.message.contains("choose Retry"), "{}", err.message);
}

#[test]
fn registration_unknown_message_says_git_did_not_answer_and_nothing_was_touched() {
    let msg = registration_unknown_message(Path::new("C:/w/s1"));
    assert!(msg.contains("Git did not answer in time"), "{msg}");
    assert!(msg.contains("Nothing was touched"), "{msg}");
}
