// Listing: newest first, `limit` counts listed Conversations, and no limit lists them all.

use super::list_conversations;

const TITLE: &str = r#"{"type":"title","title":"T"}"#;
const USER: &str = r#"{"type":"message","message":{"role":"user","content":"hello"}}"#;

/// `n` is the minute in the file-name timestamp, so a higher `n` is newer.
async fn write_conversation(dir: &std::path::Path, n: u32, body: &str) {
    let name = format!("2026-11-19T10-{n:02}-00-000Z_id{n}.jsonl");
    tokio::fs::write(dir.join(name), body).await.unwrap();
}

async fn scratch_dir(name: &str) -> (std::path::PathBuf, String) {
    let dir = crate::test_scratch::path(name);
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let as_text = dir.to_string_lossy().into_owned();
    (dir, as_text)
}

fn ids(list: &[super::ConversationInfo]) -> Vec<&str> {
    list.iter().map(|c| c.id.as_str()).collect()
}

#[tokio::test]
async fn no_limit_lists_every_conversation_newest_first() {
    let (dir, text) = scratch_dir("list-all").await;
    for n in [1, 3, 2, 5, 4] {
        write_conversation(&dir, n, &format!("{TITLE}\n{USER}\n")).await;
    }
    let list = list_conversations(Some(&text), None, None).await;
    assert_eq!(ids(&list), ["id5", "id4", "id3", "id2", "id1"]);
}

#[tokio::test]
async fn a_limit_returns_that_many_even_when_newer_files_are_skipped() {
    let (dir, text) = scratch_dir("list-limit").await;
    write_conversation(&dir, 1, &format!("{TITLE}\n{USER}\n")).await;
    write_conversation(&dir, 2, &format!("{TITLE}\n{USER}\n")).await;
    write_conversation(&dir, 3, &format!("{TITLE}\n{USER}\n")).await;
    // The two newest hold no user message, so they are skipped, not counted.
    write_conversation(&dir, 4, "").await;
    write_conversation(&dir, 5, &format!("{TITLE}\n")).await;
    let list = list_conversations(Some(&text), None, Some(2)).await;
    assert_eq!(ids(&list), ["id3", "id2"]);
}

#[tokio::test]
async fn a_limit_above_the_count_lists_what_there_is() {
    let (dir, text) = scratch_dir("list-over").await;
    write_conversation(&dir, 1, &format!("{TITLE}\n{USER}\n")).await;
    let list = list_conversations(Some(&text), None, Some(10)).await;
    assert_eq!(ids(&list), ["id1"]);
}

#[tokio::test]
async fn the_current_conversation_is_flagged() {
    let (dir, text) = scratch_dir("list-current").await;
    write_conversation(&dir, 1, &format!("{TITLE}\n{USER}\n")).await;
    let current = dir
        .join("2026-11-19T10-01-00-000Z_id1.jsonl")
        .to_string_lossy()
        .into_owned();
    let list = list_conversations(Some(&text), Some(&current), Some(1)).await;
    assert!(list[0].is_current);
}
