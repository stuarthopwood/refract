// Tests for `store::list_cache`: round trip, missing or corrupt file, bad shapes, clear.
use super::*;
use serde_json::json;

/// A fresh, uniquely-named scratch directory under the OS temp root.
async fn scratch_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir()
        .join("scratch")
        .join("lane-1901-a")
        .join(format!("list-cache-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir)
        .await
        .expect("create scratch dir");
    dir
}

fn pull_requests_result() -> Value {
    json!({ "items": [{ "number": 7 }], "hasMore": false, "skipped": [], "fetchedAt": "2026-11-27T10:00:00.000Z" })
}

fn issues_result() -> Value {
    json!({ "issues": [{ "number": 9 }], "skipped": [], "fetchedAt": "2026-11-27T10:00:01.000Z" })
}

#[tokio::test]
async fn a_missing_file_reads_as_an_empty_cache() {
    let dir = scratch_dir().await;
    let cache = read(&dir).await.unwrap();
    assert_eq!(cache, ListCache::default());
}

#[tokio::test]
async fn each_list_round_trips_and_writing_one_keeps_the_other() {
    let dir = scratch_dir().await;
    write(&dir, ListKind::PullRequests, pull_requests_result())
        .await
        .unwrap();
    write(&dir, ListKind::Issues, issues_result())
        .await
        .unwrap();
    let cache = read(&dir).await.unwrap();
    assert_eq!(cache.pull_requests, Some(pull_requests_result()));
    assert_eq!(cache.issues, Some(issues_result()));

    let newer = json!({ "items": [], "hasMore": false, "skipped": [], "fetchedAt": "2026-11-27T11:00:00.000Z" });
    write(&dir, ListKind::PullRequests, newer.clone())
        .await
        .unwrap();
    let cache = read(&dir).await.unwrap();
    assert_eq!(cache.pull_requests, Some(newer));
    assert_eq!(cache.issues, Some(issues_result()));
}

#[tokio::test]
async fn a_corrupt_file_reads_as_empty_and_is_quarantined() {
    let dir = scratch_dir().await;
    tokio::fs::write(dir.join("listCache.json"), b"{ not json")
        .await
        .unwrap();
    let cache = read(&dir).await.unwrap();
    assert_eq!(cache, ListCache::default());
    assert!(!dir.join("listCache.json").exists());
}

#[tokio::test]
async fn a_section_without_the_list_shape_is_dropped_on_read() {
    let dir = scratch_dir().await;
    let file = json!({
        "version": 1,
        "pullRequests": { "items": "oops", "skipped": [], "fetchedAt": "x" },
        "issues": issues_result()
    });
    tokio::fs::write(dir.join("listCache.json"), file.to_string())
        .await
        .unwrap();
    let cache = read(&dir).await.unwrap();
    assert_eq!(cache.pull_requests, None);
    assert_eq!(cache.issues, Some(issues_result()));
}

#[tokio::test]
async fn another_version_reads_as_empty() {
    let dir = scratch_dir().await;
    let file = json!({ "version": 99, "issues": issues_result() });
    tokio::fs::write(dir.join("listCache.json"), file.to_string())
        .await
        .unwrap();
    assert_eq!(read(&dir).await.unwrap(), ListCache::default());
}

#[tokio::test]
async fn a_result_without_the_list_shape_is_never_written() {
    let dir = scratch_dir().await;
    write(&dir, ListKind::Issues, json!({ "items": [] }))
        .await
        .unwrap();
    assert!(!dir.join("listCache.json").exists());
}

#[tokio::test]
async fn clear_removes_the_file_and_a_second_clear_is_fine() {
    let dir = scratch_dir().await;
    write(&dir, ListKind::Issues, issues_result())
        .await
        .unwrap();
    clear(&dir).await.unwrap();
    assert!(!dir.join("listCache.json").exists());
    clear(&dir).await.unwrap();
    assert_eq!(read(&dir).await.unwrap(), ListCache::default());
}
