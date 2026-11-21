// The handoff label on saved history is applied to a copy, never to the cached list; the cache is
// bounded by entry count and by bytes.

use super::{insert_bounded, load_saved_history, Items, Key, CACHE};
use crate::agent_tools::checklist_envelope::wrap;
use crate::checklist::model::{SendAction, SendRecord};
use crate::checklist::records::text_hash;
use crate::omp::transcript::{MessageSource, TranscriptItem};
use crate::session::saved_history::SavedHistory;
use crate::store::handoff_notes;

async fn write_history(dir: &std::path::Path, name: &str) -> String {
    tokio::fs::create_dir_all(dir).await.unwrap();
    let path = dir.join(name);
    let line = r#"{"type":"message","id":"e1","message":{"role":"user","content":[{"type":"text","text":"hi"}],"timestamp":1}}"#;
    tokio::fs::write(&path, format!("{line}\n")).await.unwrap();
    path.to_string_lossy().into_owned()
}

fn first_source(history: &SavedHistory) -> Option<MessageSource> {
    let SavedHistory::Items(items) = history else {
        panic!("expected items");
    };
    items.iter().find_map(|item| match &**item {
        TranscriptItem::User { source, .. } => source.clone(),
        _ => None,
    })
}

#[tokio::test]
async fn a_listed_file_gets_a_labelled_copy_and_the_cache_stays_unlabelled() {
    let dir = crate::test_scratch::path("saved-history-note");
    let file = write_history(&dir, "note.jsonl").await;
    handoff_notes::use_dir_for_test(dir.clone());
    handoff_notes::record_in(&dir, "note.jsonl", 1).await;
    let session_dir = dir.to_string_lossy().into_owned();

    let history = load_saved_history(Some(&session_dir), Some(&file), &[]).await;

    assert_eq!(first_source(&history), Some(MessageSource::Handoff));
    let cached = CACHE
        .lock()
        .unwrap()
        .iter()
        .find(|(key, _)| key.0.ends_with("note.jsonl"))
        .map(|(_, items)| items.clone())
        .expect("cached after load");
    assert!(cached.iter().all(|item| !matches!(
        &**item,
        TranscriptItem::User {
            source: Some(_),
            ..
        }
    )));
    // A second load still starts from the unlabelled cache entry.
    let again = load_saved_history(Some(&session_dir), Some(&file), &[]).await;
    assert_eq!(first_source(&again), Some(MessageSource::Handoff));
}

#[tokio::test]
async fn an_unlisted_file_is_untouched() {
    let dir = crate::test_scratch::path("saved-history-plain");
    let file = write_history(&dir, "plain.jsonl").await;
    handoff_notes::use_dir_for_test(dir.clone());
    let session_dir = dir.to_string_lossy().into_owned();

    let history = load_saved_history(Some(&session_dir), Some(&file), &[]).await;

    assert_eq!(first_source(&history), None);
}

async fn write_turn(dir: &std::path::Path, name: &str, text: &str) -> String {
    tokio::fs::create_dir_all(dir).await.unwrap();
    let path = dir.join(name);
    let line = serde_json::json!({"type": "message", "id": "e1", "message": {
        "role": "user", "content": [{"type": "text", "text": text}], "timestamp": 1}});
    tokio::fs::write(&path, format!("{line}\n")).await.unwrap();
    path.to_string_lossy().into_owned()
}

fn turn() -> String {
    wrap("c1", "i1", 3, SendAction::Ask, "what next?")
}

fn records() -> Vec<SendRecord> {
    vec![SendRecord {
        checklist_id: "c1".into(),
        item_id: "i1".into(),
        rev: 3,
        action: SendAction::Ask,
        text_hash: text_hash(&turn()),
    }]
}

fn first_text(history: &SavedHistory) -> String {
    let SavedHistory::Items(items) = history else {
        panic!("expected items");
    };
    items
        .iter()
        .find_map(|item| match &**item {
            TranscriptItem::User { text, .. } => Some(text.clone()),
            _ => None,
        })
        .unwrap()
}

#[tokio::test]
async fn reload_labels_matching_checklist_turn() {
    let dir = crate::test_scratch::path("saved-history-card");
    let file = write_turn(&dir, "card.jsonl", &turn()).await;
    handoff_notes::use_dir_for_test(dir.clone());
    let session_dir = dir.to_string_lossy().into_owned();

    let history = load_saved_history(Some(&session_dir), Some(&file), &records()).await;

    assert!(matches!(
        first_source(&history),
        Some(MessageSource::ChecklistItem { .. })
    ));
    assert_eq!(first_text(&history), "what next?");
}

#[tokio::test]
async fn a_labelled_load_leaves_the_cache_unlabelled() {
    let dir = crate::test_scratch::path("saved-history-card-cache");
    let file = write_turn(&dir, "cardcache.jsonl", &turn()).await;
    handoff_notes::use_dir_for_test(dir.clone());
    let session_dir = dir.to_string_lossy().into_owned();

    let labelled = load_saved_history(Some(&session_dir), Some(&file), &records()).await;
    let plain = load_saved_history(Some(&session_dir), Some(&file), &[]).await;

    assert!(first_source(&labelled).is_some());
    assert_eq!(first_source(&plain), None);
    assert_eq!(first_text(&plain), turn());
}

#[tokio::test]
async fn reload_skips_handoff_note_turn() {
    let dir = crate::test_scratch::path("saved-history-card-note");
    let file = write_turn(&dir, "cardnote.jsonl", &turn()).await;
    handoff_notes::use_dir_for_test(dir.clone());
    handoff_notes::record_in(&dir, "cardnote.jsonl", 1).await;
    let session_dir = dir.to_string_lossy().into_owned();

    let history = load_saved_history(Some(&session_dir), Some(&file), &records()).await;

    assert_eq!(first_source(&history), Some(MessageSource::Handoff));
    assert_eq!(first_text(&history), turn());
}

#[tokio::test]
async fn reload_without_store_leaves_plain_text() {
    let dir = crate::test_scratch::path("saved-history-card-none");
    let file = write_turn(&dir, "nocard.jsonl", &turn()).await;
    handoff_notes::use_dir_for_test(dir.clone());
    let session_dir = dir.to_string_lossy().into_owned();

    let history = load_saved_history(Some(&session_dir), Some(&file), &[]).await;

    assert_eq!(first_source(&history), None);
    assert_eq!(first_text(&history), turn());
}

fn entry(name: &str, len: u64) -> (Key, Items) {
    let key = (
        std::path::PathBuf::from(name),
        std::time::SystemTime::UNIX_EPOCH,
        len,
    );
    (key, std::sync::Arc::new(Vec::new()))
}

fn names(cache: &[(Key, Items)]) -> Vec<String> {
    cache
        .iter()
        .map(|(key, _)| key.0.to_string_lossy().into_owned())
        .collect()
}

#[test]
fn the_oldest_entries_are_evicted_until_the_byte_total_fits() {
    let mut cache = Vec::new();
    for (name, len) in [("a", 40), ("b", 40), ("c", 40)] {
        let (key, items) = entry(name, len);
        insert_bounded(&mut cache, key, items, 10, 100);
    }
    assert_eq!(names(&cache), ["b", "c"]);
}

#[test]
fn a_file_over_the_byte_bound_is_not_cached_and_keeps_the_rest() {
    let mut cache = Vec::new();
    let (key, items) = entry("small", 10);
    insert_bounded(&mut cache, key, items, 10, 100);
    let (key, items) = entry("huge", 101);
    insert_bounded(&mut cache, key, items, 10, 100);
    assert_eq!(names(&cache), ["small"]);
}

#[test]
fn a_rewritten_file_replaces_its_old_entry_and_the_count_bound_still_holds() {
    let mut cache = Vec::new();
    for name in ["a", "b", "a", "c"] {
        let (key, items) = entry(name, 1);
        insert_bounded(&mut cache, key, items, 2, 100);
    }
    assert_eq!(names(&cache), ["a", "c"]);
}
