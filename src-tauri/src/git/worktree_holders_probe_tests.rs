// Tests for the rename probe behind Delete (`check_folder_in_use`), against real folders under a
// scratch worktrees root. Restart Manager is not exercised: it names holders, it never moves anything.

use super::*;
use crate::git::test_support::init_repo;

/// A one-file Session folder under the repo's worktrees root.
async fn session_folder(repo: &Path, name: &str) -> PathBuf {
    let folder = worktrees_root(repo).join(name);
    tokio::fs::create_dir_all(&folder).await.unwrap();
    tokio::fs::write(folder.join("work.txt"), b"unsaved work")
        .await
        .unwrap();
    folder
}

fn probe_of(folder: &Path) -> PathBuf {
    probe_sibling_path(folder).expect("folder has a name")
}

#[tokio::test(start_paused = true)]
async fn a_free_folder_passes_and_ends_up_exactly_where_it_was() {
    let repo = init_repo().await;
    let folder = session_folder(&repo, "free").await;

    check_folder_in_use(&repo, &folder, "s1", &[])
        .await
        .expect("nothing holds the folder");

    assert!(
        folder.join("work.txt").is_file(),
        "rename-back must restore the folder"
    );
    assert!(
        tokio::fs::symlink_metadata(probe_of(&folder))
            .await
            .is_err(),
        "the probe name must not be left behind"
    );
}

#[tokio::test(start_paused = true)]
async fn a_folder_that_is_already_gone_passes() {
    let repo = init_repo().await;
    let folder = worktrees_root(&repo).join("gone");

    assert!(check_folder_in_use(&repo, &folder, "s1", &[]).await.is_ok());
}

// Only Windows refuses to rename a folder that has a file open inside it.
#[cfg(windows)]
#[tokio::test(start_paused = true)]
async fn a_folder_with_an_open_file_is_reported_held_and_never_moved() {
    let repo = init_repo().await;
    let folder = session_folder(&repo, "held").await;
    let _open = std::fs::File::open(folder.join("work.txt")).expect("hold a file open");

    let err = check_folder_in_use(&repo, &folder, "s1", &[])
        .await
        .expect_err("an open file must block the probe");

    assert_eq!(err.code, GitErrorCode::WorktreeHeld);
    assert_eq!(err.message, FOLDER_IN_USE_MESSAGE);
    assert!(
        folder.join("work.txt").is_file(),
        "a held folder must stay put"
    );
    assert!(tokio::fs::symlink_metadata(probe_of(&folder))
        .await
        .is_err());
}

#[tokio::test(start_paused = true)]
async fn a_leftover_probe_folder_is_refused_without_touching_the_worktree() {
    let repo = init_repo().await;
    let folder = session_folder(&repo, "stale").await;
    let probe = probe_of(&folder);
    tokio::fs::create_dir_all(&probe).await.unwrap();

    let err = check_folder_in_use(&repo, &folder, "s1", &[])
        .await
        .expect_err("a leftover probe must be refused");

    assert_eq!(err.code, GitErrorCode::WorktreeHeld);
    assert!(
        err.message.contains("leftover probe folder"),
        "{}",
        err.message
    );
    assert!(folder.join("work.txt").is_file());
}

#[tokio::test(start_paused = true)]
async fn a_crashed_delete_that_left_the_folder_at_its_probe_name_tells_the_user_where_it_is() {
    let repo = init_repo().await;
    let folder = session_folder(&repo, "crashed").await;
    let probe = probe_of(&folder);
    tokio::fs::rename(&folder, &probe).await.unwrap();

    let err = check_folder_in_use(&repo, &folder, "s1", &[])
        .await
        .expect_err("the worktree is missing but its files are at the probe name");

    assert_eq!(err.code, GitErrorCode::WorktreeHeld);
    assert!(err.message.contains("Nothing was lost"), "{}", err.message);
    assert!(
        err.message.contains("refract-delete-probe"),
        "{}",
        err.message
    );
    assert!(
        probe.join("work.txt").is_file(),
        "the files must not be moved again"
    );
}

#[tokio::test(start_paused = true)]
async fn a_folder_outside_the_worktrees_root_is_refused_and_not_renamed() {
    let repo = init_repo().await;
    let outside = crate::test_scratch::path(format!("refract-outside-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&outside).await.unwrap();
    tokio::fs::write(outside.join("keep.txt"), b"mine")
        .await
        .unwrap();

    let err = check_folder_in_use(&repo, &outside, "s1", &[])
        .await
        .expect_err("outside the root");

    assert_eq!(err.code, GitErrorCode::WorktreeFailed);
    assert!(outside.join("keep.txt").is_file());
    assert!(tokio::fs::symlink_metadata(probe_of(&outside))
        .await
        .is_err());
}
