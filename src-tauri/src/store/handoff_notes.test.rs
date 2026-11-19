// Sidecar tests: unreadable files read empty, keys are file names, records accumulate, the file is
// read once, and the oldest entries are pruned.

use super::{contains_in, file_in, prune, record_in, Entry, Notes};

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

#[tokio::test]
async fn a_second_lookup_is_served_from_memory() {
    let dir = scratch();
    record_in(&dir, "a.jsonl", 1).await;
    assert!(contains_in(&dir, "a.jsonl").await);
    // A disk read would now find garbage and report the label gone.
    tokio::fs::write(file_in(&dir), b"{ not json")
        .await
        .unwrap();
    assert!(contains_in(&dir, "a.jsonl").await);
}

#[tokio::test]
async fn the_first_lookup_loads_the_disk_file_once() {
    let dir = scratch();
    tokio::fs::create_dir_all(&dir).await.unwrap();
    tokio::fs::write(file_in(&dir), br#"{"old.jsonl":{"at":1}}"#)
        .await
        .unwrap();
    assert!(contains_in(&dir, "old.jsonl").await);
    tokio::fs::remove_file(file_in(&dir)).await.unwrap();
    assert!(contains_in(&dir, "old.jsonl").await);
}

#[test]
fn pruning_drops_the_oldest_entries_first() {
    let mut notes = Notes::new();
    for (key, at) in [
        ("c.jsonl", 3),
        ("a.jsonl", 1),
        ("d.jsonl", 4),
        ("b.jsonl", 2),
    ] {
        notes.insert(key.to_string(), Entry { at });
    }
    prune(&mut notes, 2);
    assert_eq!(
        notes.keys().map(String::as_str).collect::<Vec<_>>(),
        ["c.jsonl", "d.jsonl"]
    );
}
