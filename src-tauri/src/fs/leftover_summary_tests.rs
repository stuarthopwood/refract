// Test module for `leftover_summary.rs`, split into its own file via `#[path = ...]` (same
// pattern every other lane-owned Rust file in this crate uses).

use super::*;
use std::path::PathBuf;

fn scratch_dir() -> PathBuf {
    std::env::temp_dir().join(format!("refract-leftover-summary-{}", uuid::Uuid::new_v4()))
}

#[tokio::test]
async fn empty_for_a_missing_folder() {
    let missing = scratch_dir();
    let summary = compute_leftover_summary(&missing).await;
    assert!(summary.generated_folders.is_empty());
    assert!(summary.other_files.is_empty());
    assert_eq!(summary.more_count, 0);
}

#[tokio::test]
async fn empty_for_an_empty_folder() {
    let dir = scratch_dir();
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let summary = compute_leftover_summary(&dir).await;
    assert!(summary.generated_folders.is_empty());
    assert!(summary.other_files.is_empty());
}

#[tokio::test]
async fn buckets_a_nested_node_modules_folder_by_name_with_a_file_count() {
    let dir = scratch_dir();
    tokio::fs::create_dir_all(dir.join("patient/client/node_modules/pkg-a")).await.unwrap();
    tokio::fs::create_dir_all(dir.join("server/node_modules/pkg-b")).await.unwrap();
    tokio::fs::write(dir.join("patient/client/node_modules/pkg-a/index.js"), b"x").await.unwrap();
    tokio::fs::write(dir.join("patient/client/node_modules/pkg-a/package.json"), b"x").await.unwrap();
    tokio::fs::write(dir.join("server/node_modules/pkg-b/index.js"), b"x").await.unwrap();

    let summary = compute_leftover_summary(&dir).await;
    assert_eq!(summary.generated_folders.len(), 1, "both occurrences merge into one bucket");
    let node_modules = &summary.generated_folders[0];
    assert_eq!(node_modules.name, "node_modules");
    assert_eq!(node_modules.file_count, 3);
}

#[tokio::test]
async fn lists_other_files_by_relative_path() {
    let dir = scratch_dir();
    tokio::fs::create_dir_all(dir.join("sub")).await.unwrap();
    tokio::fs::write(dir.join("top.txt"), b"x").await.unwrap();
    tokio::fs::write(dir.join("sub/nested.txt"), b"x").await.unwrap();

    let summary = compute_leftover_summary(&dir).await;
    assert_eq!(summary.other_files.len(), 2);
    assert!(summary.other_files.iter().any(|p| p == "top.txt"));
    assert!(summary.other_files.iter().any(|p| p == "sub/nested.txt"));
}

#[tokio::test]
async fn caps_other_files_and_reports_the_remainder_as_more_count() {
    let dir = scratch_dir();
    tokio::fs::create_dir_all(&dir).await.unwrap();
    for i in 0..(MAX_OTHER_FILES_LISTED + 7) {
        tokio::fs::write(dir.join(format!("file-{i}.txt")), b"x").await.unwrap();
    }
    let summary = compute_leftover_summary(&dir).await;
    assert_eq!(summary.other_files.len(), MAX_OTHER_FILES_LISTED);
    assert_eq!(summary.more_count, 7);
}

/// A junction inside the tree is never descended, matching `fs::remove_tree`'s own rule: its
/// contents are never counted, and (when its name does not match a generated-folder bucket) it
/// is listed as one "other" entry by its own path, never traversed into.
#[tokio::test]
async fn never_descends_through_a_junction() {
    let dir = scratch_dir();
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let outside = std::env::temp_dir().join(format!("refract-leftover-summary-target-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&outside).await.unwrap();
    tokio::fs::write(outside.join("inside.txt"), b"x").await.unwrap();

    let junction = dir.join("linked");
    let status = tokio::process::Command::new("cmd")
        .args(["/C", "mklink", "/J", &junction.to_string_lossy(), &outside.to_string_lossy()])
        .status()
        .await;
    let succeeded = matches!(status, Ok(s) if s.success());
    if !succeeded {
        if std::env::var("CI").is_ok() {
            panic!("junction creation failed in CI: mklink /J {junction:?} {outside:?}");
        }
        eprintln!("skipping junction test: mklink refused (sandbox restriction, not CI)");
        return;
    }

    let summary = compute_leftover_summary(&dir).await;
    assert!(summary.generated_folders.is_empty());
    assert_eq!(summary.other_files, vec!["linked".to_string()]);
}
