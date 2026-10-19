// Test module for `remove_tree.rs`, split into its own file via `#[path = ...]` (same pattern
// `git/worktree_delete.rs` uses for `worktree_delete_tests.rs`).

use super::*;

fn scratch_root() -> PathBuf {
    std::env::temp_dir().join(format!("refract-remove-tree-{}", uuid::Uuid::new_v4()))
}

#[tokio::test]
async fn removes_an_empty_directory() {
    let root = scratch_root();
    let target = root.join("empty");
    tokio::fs::create_dir_all(&target).await.unwrap();
    remove_tree(&target, &root).await.expect("remove");
    assert!(tokio::fs::metadata(&target).await.is_err());
}

#[tokio::test]
async fn removes_nested_files_and_folders() {
    let root = scratch_root();
    let target = root.join("tree");
    tokio::fs::create_dir_all(target.join("a/b/c")).await.unwrap();
    tokio::fs::write(target.join("top.txt"), b"x").await.unwrap();
    tokio::fs::write(target.join("a/mid.txt"), b"x").await.unwrap();
    tokio::fs::write(target.join("a/b/c/deep.txt"), b"x").await.unwrap();
    remove_tree(&target, &root).await.expect("remove");
    assert!(tokio::fs::metadata(&target).await.is_err());
}

#[tokio::test]
async fn clears_read_only_files_before_removing_them() {
    let root = scratch_root();
    let target = root.join("tree");
    tokio::fs::create_dir_all(&target).await.unwrap();
    let file = target.join("locked.txt");
    tokio::fs::write(&file, b"x").await.unwrap();
    let mut perms = tokio::fs::metadata(&file).await.unwrap().permissions();
    perms.set_readonly(true);
    tokio::fs::set_permissions(&file, perms).await.unwrap();
    remove_tree(&target, &root).await.expect("remove despite read-only file");
    assert!(tokio::fs::metadata(&target).await.is_err());
}

/// The safety property this whole module exists for: a junction inside the tree is removed as
/// a link, never descended -- its real target must survive completely untouched.
#[tokio::test]
async fn removes_a_junction_as_a_link_without_touching_its_target() {
    let root = scratch_root();
    let target = root.join("tree");
    tokio::fs::create_dir_all(&target).await.unwrap();
    let outside_target =
        std::env::temp_dir().join(format!("refract-remove-tree-target-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&outside_target).await.unwrap();
    let marker = outside_target.join("marker.txt");
    tokio::fs::write(&marker, b"do not touch").await.unwrap();

    let junction = target.join("junc");
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
        eprintln!("skipping junction test: mklink refused (sandbox restriction, not CI)");
        return;
    }

    remove_tree(&target, &root).await.expect("remove");
    assert!(
        tokio::fs::metadata(&target).await.is_err(),
        "the tree itself, including the junction link, must be gone"
    );
    assert!(
        tokio::fs::metadata(&marker).await.is_ok(),
        "the junction's real target must survive untouched"
    );
}

#[tokio::test]
async fn refuses_to_remove_the_boundary_root_itself() {
    let root = scratch_root();
    tokio::fs::create_dir_all(&root).await.unwrap();
    let result = remove_tree(&root, &root).await;
    assert!(matches!(result, Err(RemoveTreeError::OutsideBoundary)));
    assert!(tokio::fs::metadata(&root).await.is_ok());
}

#[tokio::test]
async fn refuses_a_path_outside_the_boundary_root() {
    let root = scratch_root();
    tokio::fs::create_dir_all(&root).await.unwrap();
    let elsewhere =
        std::env::temp_dir().join(format!("refract-remove-tree-elsewhere-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&elsewhere).await.unwrap();
    tokio::fs::write(elsewhere.join("keep.txt"), b"keep").await.unwrap();
    let result = remove_tree(&elsewhere, &root).await;
    assert!(matches!(result, Err(RemoveTreeError::OutsideBoundary)));
    assert!(tokio::fs::metadata(elsewhere.join("keep.txt")).await.is_ok());
}

/// A directory reached only through an upstream junction resolves, canonically, to somewhere
/// outside the boundary root -- refused before any deletion starts, exactly like
/// `worktree_delete_tests.rs`'s own marker-outside-a-junction test for `remove_session_worktree`.
#[tokio::test]
async fn refuses_a_path_whose_canonical_form_escapes_through_an_upstream_junction() {
    let root = scratch_root();
    tokio::fs::create_dir_all(&root).await.unwrap();
    let outside_target =
        std::env::temp_dir().join(format!("refract-remove-tree-upstream-{}", uuid::Uuid::new_v4()));
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
        eprintln!("skipping junction test: mklink refused (sandbox restriction, not CI)");
        return;
    }

    let result = remove_tree(&junction.join("session"), &root).await;
    assert!(matches!(result, Err(RemoveTreeError::OutsideBoundary)));
    assert!(tokio::fs::metadata(&marker).await.is_ok());
}

#[tokio::test]
async fn removes_a_deep_tree_with_a_long_path_component() {
    let root = scratch_root();
    let mut target = root.join("tree");
    tokio::fs::create_dir_all(&target).await.unwrap();
    // Build a path comfortably over the 260-character MAX_PATH threshold so this test only
    // passes if the `\\?\` verbatim-path fallback actually works.
    let long_name = "a".repeat(80);
    for _ in 0..4 {
        target = target.join(&long_name);
    }
    tokio::fs::create_dir_all(&target).await.unwrap();
    tokio::fs::write(target.join("deep.txt"), b"x").await.unwrap();
    assert!(target.to_string_lossy().len() > LONG_PATH_THRESHOLD);
    remove_tree(&root.join("tree"), &root)
        .await
        .expect("remove a tree with a long path");
    assert!(tokio::fs::metadata(&root.join("tree")).await.is_err());
}
