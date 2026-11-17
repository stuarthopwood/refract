// Sidecar tests: unreadable files read empty, keys are file names, records accumulate.

use super::{contains_in, file_in, record_in};

fn scratch() -> std::path::PathBuf {
    crate::test_scratch::path("handoff-notes")
}

#[tokio::test]
async fn a_missing_file_reads_empty() {
    assert!(!contains_in(&scratch(), "a.jsonl").await);
}

#[tokio::test]
async fn an_unparseable_file_reads_empty() {
    let dir = scratch();
    tokio::fs::create_dir_all(&dir).await.unwrap();
    tokio::fs::write(file_in(&dir), b"{ not json")
        .await
        .unwrap();
    assert!(!contains_in(&dir, "a.jsonl").await);
}

#[tokio::test]
async fn a_recorded_file_is_contained() {
    let dir = scratch();
    record_in(&dir, "a.jsonl", 5).await;
    assert!(contains_in(&dir, "a.jsonl").await);
    assert!(!contains_in(&dir, "b.jsonl").await);
}

#[tokio::test]
async fn a_path_key_is_reduced_to_its_file_name() {
    let dir = scratch();
    record_in(&dir, "C:\\sessions\\x\\a.jsonl", 5).await;
    assert!(contains_in(&dir, "/other/place/a.jsonl").await);
    let raw = tokio::fs::read_to_string(file_in(&dir)).await.unwrap();
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(json, serde_json::json!({ "a.jsonl": { "at": 5 } }));
}

#[tokio::test]
async fn recording_a_second_file_keeps_the_first() {
    let dir = scratch();
    record_in(&dir, "a.jsonl", 1).await;
    record_in(&dir, "b.jsonl", 2).await;
    assert!(contains_in(&dir, "a.jsonl").await);
    assert!(contains_in(&dir, "b.jsonl").await);
}
