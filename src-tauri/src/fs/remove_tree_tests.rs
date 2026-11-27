// Temp dirs only: these tests never touch a real `~/.omp`.

use super::*;

async fn scratch_root(label: &str) -> PathBuf {
    let root = crate::test_scratch::path(format!("remove-file-{label}-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&root).await.unwrap();
    root
}

#[cfg(windows)]
fn make_file_link(link: &Path, target: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(target, link)
}

#[cfg(unix)]
fn make_file_link(link: &Path, target: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[tokio::test]
async fn remove_file_removes_a_file_inside_the_root() {
    let root = scratch_root("inside").await;
    let file = root.join("a.jsonl");
    tokio::fs::write(&file, b"x").await.unwrap();

    remove_file(&file, &root).await.unwrap();

    assert!(tokio::fs::metadata(&file).await.is_err());
}

#[tokio::test]
async fn remove_file_treats_an_already_gone_file_as_ok() {
    let root = scratch_root("gone").await;

    remove_file(&root.join("never-existed.jsonl"), &root)
        .await
        .unwrap();
}

#[tokio::test]
async fn remove_file_refuses_the_root_itself() {
    let root = scratch_root("root").await;
    tokio::fs::write(root.join("keep.jsonl"), b"x")
        .await
        .unwrap();

    let err = remove_file(&root, &root).await.unwrap_err();

    assert!(matches!(err, RemoveTreeError::OutsideBoundary));
    assert!(tokio::fs::metadata(root.join("keep.jsonl")).await.is_ok());
}

#[tokio::test]
async fn remove_file_refuses_a_file_outside_the_root() {
    let root = scratch_root("boundary").await;
    let elsewhere = scratch_root("elsewhere").await;
    let outside = elsewhere.join("keep.jsonl");
    tokio::fs::write(&outside, b"x").await.unwrap();

    let err = remove_file(&outside, &root).await.unwrap_err();

    assert!(matches!(err, RemoveTreeError::OutsideBoundary));
    assert!(tokio::fs::metadata(&outside).await.is_ok());
}

/// Skips outside CI when the OS refuses link creation, fails in CI.
#[tokio::test]
async fn remove_file_refuses_a_symlink_and_leaves_its_target() {
    let root = scratch_root("link").await;
    let target = root.join("real.jsonl");
    tokio::fs::write(&target, b"x").await.unwrap();
    let link = root.join("link.jsonl");
    if let Err(err) = make_file_link(&link, &target) {
        if std::env::var("CI").is_ok() {
            panic!("symlink creation failed in CI: {err}");
        }
        eprintln!("skipping symlink test: link creation refused ({err})");
        return;
    }

    let err = remove_file(&link, &root).await.unwrap_err();

    assert!(matches!(err, RemoveTreeError::OutsideBoundary));
    assert!(tokio::fs::metadata(&target).await.is_ok());
}

#[tokio::test]
async fn remove_tree_refuses_the_root_itself() {
    let root = scratch_root("tree-root").await;
    tokio::fs::create_dir_all(root.join("child")).await.unwrap();
    tokio::fs::write(root.join("child").join("keep.txt"), b"x")
        .await
        .unwrap();

    let err = remove_tree(&root, &root).await.unwrap_err();

    assert!(matches!(err, RemoveTreeError::OutsideBoundary));
    assert!(tokio::fs::metadata(root.join("child").join("keep.txt"))
        .await
        .is_ok());
}

#[tokio::test]
async fn remove_tree_refuses_a_folder_outside_the_root() {
    let root = scratch_root("tree-boundary").await;
    let elsewhere = scratch_root("tree-elsewhere").await;
    tokio::fs::write(elsewhere.join("keep.txt"), b"x")
        .await
        .unwrap();

    let err = remove_tree(&elsewhere, &root).await.unwrap_err();

    assert!(matches!(err, RemoveTreeError::OutsideBoundary));
    assert!(tokio::fs::metadata(elsewhere.join("keep.txt"))
        .await
        .is_ok());
}

#[cfg(windows)]
fn junction_or_skip(link: &Path, target: &Path) -> bool {
    let made = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .is_ok_and(|out| out.status.success());
    if !made {
        assert!(
            std::env::var("CI").is_err(),
            "junction creation failed in CI: {link:?} -> {target:?}"
        );
        eprintln!("skipping: mklink refused (sandbox restriction, not CI)");
    }
    made
}

/// Skips outside CI when the OS refuses junction creation, fails in CI.
#[cfg(windows)]
#[tokio::test]
async fn remove_tree_refuses_a_junction_and_leaves_its_target() {
    let root = scratch_root("tree-junction").await;
    let outside = scratch_root("tree-junction-target").await;
    tokio::fs::write(outside.join("sentinel.txt"), b"x")
        .await
        .unwrap();
    let link = root.join("linked");
    if !junction_or_skip(&link, &outside) {
        return;
    }

    let err = remove_tree(&link, &root).await.unwrap_err();

    assert!(matches!(err, RemoveTreeError::OutsideBoundary));
    assert!(tokio::fs::metadata(outside.join("sentinel.txt"))
        .await
        .is_ok());
}
