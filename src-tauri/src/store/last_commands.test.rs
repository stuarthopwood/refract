// Round-trip, missing file and corrupt file for the persisted command list.

use serde_json::{json, Value};

use super::{load_in, save_in, FILE_NAME};

fn scratch(label: &str) -> std::path::PathBuf {
    crate::test_scratch::path(format!("refract-last-commands-{label}-{}", uuid::Uuid::new_v4()))
}

fn sample() -> Vec<Value> {
    vec![
        json!({ "name": "todo", "description": "Manage todos", "source": "builtin" }),
        json!({ "name": "review", "source": "file" }),
    ]
}

#[tokio::test]
async fn a_saved_list_round_trips_unchanged() {
    let dir = scratch("round-trip");
    save_in(&dir, &sample()).await;
    assert_eq!(load_in(&dir).await, Some(sample()));
}

#[tokio::test]
async fn a_missing_file_gives_none() {
    let dir = scratch("missing");
    assert_eq!(load_in(&dir).await, None);
}

#[tokio::test]
async fn a_corrupt_file_gives_none_and_is_quarantined() {
    let dir = scratch("corrupt");
    tokio::fs::create_dir_all(&dir).await.unwrap();
    tokio::fs::write(dir.join(FILE_NAME), b"{ not json").await.unwrap();
    assert_eq!(load_in(&dir).await, None);
    assert!(!dir.join(FILE_NAME).exists(), "the corrupt file is renamed aside");
}

#[tokio::test]
async fn a_file_of_the_wrong_shape_gives_none() {
    let dir = scratch("wrong-shape");
    tokio::fs::create_dir_all(&dir).await.unwrap();
    tokio::fs::write(dir.join(FILE_NAME), br#"{"commands":[]}"#).await.unwrap();
    assert_eq!(load_in(&dir).await, None);
}

#[tokio::test]
async fn entries_without_a_name_are_dropped_on_load() {
    let dir = scratch("nameless");
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let raw = br#"[{"description":"no name"},{"name":"todo"},42]"#;
    tokio::fs::write(dir.join(FILE_NAME), raw).await.unwrap();
    assert_eq!(load_in(&dir).await, Some(vec![json!({ "name": "todo" })]));
}

#[tokio::test]
async fn an_empty_list_does_not_overwrite_a_saved_one() {
    let dir = scratch("empty");
    save_in(&dir, &sample()).await;
    save_in(&dir, &[]).await;
    assert_eq!(load_in(&dir).await, Some(sample()));
}

#[tokio::test]
async fn a_later_list_replaces_the_earlier_one() {
    let dir = scratch("replace");
    save_in(&dir, &sample()).await;
    let newer = vec![json!({ "name": "usage" })];
    save_in(&dir, &newer).await;
    assert_eq!(load_in(&dir).await, Some(newer));
}
