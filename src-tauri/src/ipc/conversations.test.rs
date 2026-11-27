// Listing: newest first, `limit` counts listed Conversations, and no limit lists them all.

use super::list_conversations;

const TITLE: &str = r#"{"type":"title","title":"T"}"#;
const USER: &str = r#"{"type":"message","message":{"role":"user","content":"hello"}}"#;
const TITLE_EMPTY: &str = r#"{"type":"title","title":""}"#;

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

#[tokio::test]
async fn size_bytes_is_the_jsonl_plus_its_artifact_folder() {
    let (dir, text) = scratch_dir("list-size").await;
    let body = format!("{TITLE}\n{USER}\n");
    write_conversation(&dir, 1, &body).await;
    write_conversation(&dir, 2, &body).await;
    let artifact = dir.join("2026-11-19T10-01-00-000Z_id1").join("nested");
    tokio::fs::create_dir_all(&artifact).await.unwrap();
    tokio::fs::write(artifact.join("out.bin"), [0u8; 40])
        .await
        .unwrap();

    let list = list_conversations(Some(&text), None, None).await;

    let with_artifact = list.iter().find(|c| c.id == "id1").unwrap();
    let without = list.iter().find(|c| c.id == "id2").unwrap();
    assert_eq!(without.size_bytes, body.len() as u64);
    assert_eq!(with_artifact.size_bytes, body.len() as u64 + 40);
}

// ---- titles cut from the first user message (#440, FR-191) ----

fn user_line(text: &str) -> String {
    serde_json::json!({ "type": "message", "message": { "role": "user", "content": text } })
        .to_string()
}

async fn title_of(name: &str, body: &str) -> String {
    let (dir, text) = scratch_dir(name).await;
    write_conversation(&dir, 1, body).await;
    list_conversations(Some(&text), None, None).await[0]
        .title
        .clone()
}

#[tokio::test]
async fn an_empty_title_line_takes_the_first_user_message() {
    let body = format!(
        "{}\n{}\n",
        r#"{"type":"title","title":""}"#,
        user_line("Fix the build")
    );
    assert_eq!(title_of("title-empty", &body).await, "Fix the build");
}

#[tokio::test]
async fn a_missing_title_line_takes_the_first_user_message() {
    let body = format!(
        "{}\n{}\n",
        r#"{"type":"session"}"#,
        user_line("Fix the build")
    );
    assert_eq!(title_of("title-missing", &body).await, "Fix the build");
}

#[tokio::test]
async fn a_multi_line_first_message_becomes_one_line() {
    let body = format!(
        "{TITLE_EMPTY}\n{}\n",
        user_line("Fix\n\n  the\tbuild\r\nplease")
    );
    assert_eq!(
        title_of("title-multiline", &body).await,
        "Fix the build please"
    );
}

#[tokio::test]
async fn a_long_first_message_is_truncated_with_an_ellipsis() {
    let body = format!("{TITLE_EMPTY}\n{}\n", user_line(&"word ".repeat(40)));
    let title = title_of("title-long", &body).await;
    assert!(title.ends_with('…'));
    assert!(title.chars().count() <= 61);
    assert!(!title.contains('\n'));
}

#[tokio::test]
async fn the_preview_stays_the_raw_first_message_under_the_title() {
    let (dir, text) = scratch_dir("title-preview").await;
    write_conversation(
        &dir,
        1,
        &format!("{TITLE_EMPTY}\n{}\n", user_line("Fix the build")),
    )
    .await;
    let list = list_conversations(Some(&text), None, None).await;
    assert_eq!(list[0].title, "Fix the build");
    assert_eq!(list[0].preview, "Fix the build");
}

#[tokio::test]
async fn a_title_the_agent_already_set_is_kept() {
    let body = format!("{TITLE}\n{}\n", user_line("Fix the build"));
    assert_eq!(title_of("title-kept", &body).await, "T");
}

#[tokio::test]
async fn a_message_with_no_text_leaves_the_title_empty_for_the_fallback() {
    let body = format!("{TITLE_EMPTY}\n{}\n", user_line("   "));
    assert_eq!(title_of("title-blank", &body).await, "");
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
