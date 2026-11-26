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

// ---- saved-history labelling (the stopped-agent path of `inject_saved_history`) ----

struct StubLookup;

impl crate::omp::transcript::synthesis_labels::SynthesisLookup for StubLookup {
    fn labels(
        &self,
        tool_call_id: &str,
        _spec_index: u32,
    ) -> crate::omp::transcript::synthesis_labels::SubagentLabels {
        crate::omp::transcript::synthesis_labels::SubagentLabels {
            role: Some(format!("role-of-{tool_call_id}")),
            overall_goal: Some("Ship it".to_string()),
        }
    }
}

fn saved_subagent_rows() -> Vec<std::sync::Arc<crate::omp::transcript::TranscriptItem>> {
    let history = vec![
        serde_json::json!({ "role": "assistant", "content": [{
            "type": "toolCall", "id": "call-1", "name": "task",
            "arguments": { "tasks": [{ "name": "ImplA", "task": "do a" }] }
        }] }),
        serde_json::json!({ "role": "toolResult", "toolCallId": "call-1", "toolName": "task",
            "isError": false, "content": [],
            "details": { "progress": [{ "id": "job-0", "status": "done" }] } }),
    ];
    crate::omp::transcript::TranscriptState::from_history(&history)
        .items()
        .to_vec()
}

fn subagent_rows(value: &serde_json::Value) -> Vec<&serde_json::Value> {
    value
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["kind"] == "subagent")
        .collect()
}

#[test]
fn saved_subagent_rows_are_labelled_when_a_lookup_exists() {
    let items = saved_subagent_rows();
    let value = super::saved_items_transcript(&items, Some(&StubLookup));
    let rows = subagent_rows(&value);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["role"], "role-of-call-1");
    assert_eq!(rows[0]["overallGoal"], "Ship it");
}

#[test]
fn saved_rows_are_unchanged_when_there_is_no_lookup() {
    let items = saved_subagent_rows();
    let value = super::saved_items_transcript(&items, None);
    assert_eq!(value, serde_json::json!(items));
    let rows = subagent_rows(&value);
    assert_eq!(rows.len(), 1);
    assert!(rows[0].get("role").is_none());
}
