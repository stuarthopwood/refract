// Unit tests for `session::termination` (lane R3, issue #786): ports `terminationDetection.
// test.ts`'s own tail-parsing edge cases (empty file, truncated last line, session_exit present/
// absent, unmatched tool starts, judging each process life on its own, tail-only read guarantee,
// cache invalidation) plus `stoppedOnRequestMarker.test.ts`'s own marker record/clear/validate/
// resolve cases. `#[path]`-loaded sibling of `termination.rs` (excluded from `check:file-size` by
// its own `.test.rs` name).
//
// Scratch Conversation files are written under the OS temp directory only (never inside this
// repo) and left in place rather than deleted where harmless: each file's name is unique (pid,
// an incrementing counter, and a uuid), never reused, so leaving them is harmless.
use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};

static SCRATCH_COUNTER: AtomicU64 = AtomicU64::new(0);

async fn write_scratch(content: &str) -> String {
    let n = SCRATCH_COUNTER.fetch_add(1, Ordering::Relaxed);
    let file = std::env::temp_dir().join(format!(
        "refract-termination-test-{}-{n}-{}.jsonl",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    tokio::fs::write(&file, content).await.unwrap();
    file.to_string_lossy().into_owned()
}

fn line(obj: Value) -> String {
    format!("{}\n", serde_json::to_string(&obj).unwrap())
}

fn assistant_tool_call(id: &str, name: &str) -> String {
    line(
        json!({ "type": "message", "message": { "role": "assistant", "content": [{ "type": "toolCall", "id": id, "name": name, "arguments": {} }] } }),
    )
}

fn tool_result(tool_call_id: &str) -> String {
    line(
        json!({ "type": "message", "message": { "role": "toolResult", "toolCallId": tool_call_id, "toolName": "bash", "content": [] } }),
    )
}

fn user_message() -> String {
    line(
        json!({ "type": "message", "message": { "role": "user", "content": [{ "type": "text", "text": "hi" }] } }),
    )
}

fn session_exit(reason: Option<&str>) -> String {
    match reason {
        Some(r) => line(json!({ "type": "session_exit", "reason": r })),
        None => line(json!({ "type": "session_exit" })),
    }
}

fn aborted_assistant() -> String {
    line(
        json!({ "type": "message", "message": { "role": "assistant", "content": [{ "type": "text", "text": "partial" }], "stopReason": "aborted" } }),
    )
}

fn is_clean(result: &TerminationDetectionResult) -> bool {
    !result.terminated_unexpectedly && result.pending_tool_names.is_empty()
}

#[tokio::test]
async fn reports_clean_for_a_null_file() {
    let result = detect_unexpected_termination(None).await;
    assert!(is_clean(&result));
}

#[tokio::test]
async fn reports_clean_for_a_missing_file() {
    let missing = std::env::temp_dir().join("refract-termination-test-does-not-exist.jsonl");
    let result = detect_unexpected_termination(Some(&missing.to_string_lossy())).await;
    assert!(is_clean(&result));
}

#[tokio::test]
async fn reports_clean_for_an_empty_file() {
    let file = write_scratch("").await;
    let result = detect_unexpected_termination(Some(&file)).await;
    assert!(is_clean(&result));
}

#[tokio::test]
async fn tolerates_a_truncated_last_line() {
    let content = format!(
        "{}{}{}",
        user_message(),
        assistant_tool_call("call-1", "bash"),
        r#"{"type":"session_exit","reason":"sig"#
    );
    let file = write_scratch(&content).await;
    let result = detect_unexpected_termination(Some(&file)).await;
    assert!(result.terminated_unexpectedly);
    assert_eq!(result.pending_tool_names, vec!["bash".to_string()]);
}

#[tokio::test]
async fn session_exit_dispose_is_a_clean_stop() {
    let content = format!(
        "{}{}{}{}",
        user_message(),
        assistant_tool_call("call-1", "bash"),
        tool_result("call-1"),
        session_exit(Some("dispose"))
    );
    let file = write_scratch(&content).await;
    let result = detect_unexpected_termination(Some(&file)).await;
    assert!(is_clean(&result));
}

#[tokio::test]
async fn session_exit_sighup_is_unexpected() {
    let content = format!(
        "{}{}{}{}",
        user_message(),
        assistant_tool_call("call-1", "bash"),
        tool_result("call-1"),
        session_exit(Some("sighup"))
    );
    let file = write_scratch(&content).await;
    let result = detect_unexpected_termination(Some(&file)).await;
    assert!(result.terminated_unexpectedly);
}

#[tokio::test]
async fn session_exit_with_no_reason_reads_as_unknown_still_unexpected() {
    let content = format!("{}{}", user_message(), session_exit(None));
    let file = write_scratch(&content).await;
    let result = detect_unexpected_termination(Some(&file)).await;
    assert!(result.terminated_unexpectedly);
}

#[tokio::test]
async fn session_exit_carries_its_own_pending_tool_calls_used_as_is() {
    let content = line(
        json!({ "type": "session_exit", "reason": "sighup", "pendingToolCalls": ["ask", "eval"] }),
    );
    let file = write_scratch(&content).await;
    let result = detect_unexpected_termination(Some(&file)).await;
    assert_eq!(
        result.pending_tool_names,
        vec!["ask".to_string(), "eval".to_string()]
    );
}

#[tokio::test]
async fn a_non_string_entry_inside_pending_tool_calls_is_dropped_defensively() {
    let content = line(
        json!({ "type": "session_exit", "reason": "sighup", "pendingToolCalls": ["ask", 42, null] }),
    );
    let file = write_scratch(&content).await;
    let result = detect_unexpected_termination(Some(&file)).await;
    assert_eq!(result.pending_tool_names, vec!["ask".to_string()]);
}

#[tokio::test]
async fn no_exit_record_every_tool_call_matched_is_clean() {
    let content = format!(
        "{}{}",
        assistant_tool_call("call-1", "bash"),
        tool_result("call-1")
    );
    let file = write_scratch(&content).await;
    let result = detect_unexpected_termination(Some(&file)).await;
    assert!(is_clean(&result));
}

#[tokio::test]
async fn no_exit_record_an_unmatched_tool_call_names_the_pending_tool() {
    let content = format!(
        "{}{}",
        assistant_tool_call("call-1", "eval"),
        assistant_tool_call("call-2", "ask")
    );
    let file = write_scratch(&content).await;
    let result = detect_unexpected_termination(Some(&file)).await;
    assert!(result.terminated_unexpectedly);
    let mut names = result.pending_tool_names.clone();
    names.sort();
    assert_eq!(names, vec!["ask".to_string(), "eval".to_string()]);
}

#[tokio::test]
async fn a_later_tool_result_clears_an_earlier_pending_call() {
    let content = format!(
        "{}{}{}",
        assistant_tool_call("call-1", "eval"),
        assistant_tool_call("call-2", "wait"),
        tool_result("call-1")
    );
    let file = write_scratch(&content).await;
    let result = detect_unexpected_termination(Some(&file)).await;
    assert!(result.terminated_unexpectedly);
    assert_eq!(result.pending_tool_names, vec!["wait".to_string()]);
}

#[tokio::test]
async fn a_trailing_aborted_assistant_with_no_unresolved_tool_call_is_clean() {
    let content = format!("{}{}", user_message(), aborted_assistant());
    let file = write_scratch(&content).await;
    let result = detect_unexpected_termination(Some(&file)).await;
    assert!(is_clean(&result));
}

#[tokio::test]
async fn an_aborted_assistant_with_an_unresolved_tool_call_is_still_unexpected() {
    let content = line(
        json!({ "type": "message", "message": { "role": "assistant", "content": [{ "type": "toolCall", "id": "call-1", "name": "bash", "arguments": {} }], "stopReason": "aborted" } }),
    );
    let file = write_scratch(&content).await;
    let result = detect_unexpected_termination(Some(&file)).await;
    assert!(result.terminated_unexpectedly);
}

#[tokio::test]
async fn a_crashed_life_resumed_and_settled_cleanly_supersedes_the_old_exit_record() {
    let content = format!(
        "{}{}{}{}",
        session_exit(Some("sighup")),
        user_message(),
        assistant_tool_call("call-2", "bash"),
        tool_result("call-2")
    );
    let file = write_scratch(&content).await;
    let result = detect_unexpected_termination(Some(&file)).await;
    assert!(is_clean(&result));
}

#[tokio::test]
async fn a_crashed_life_resumed_forgets_the_earlier_unmatched_tool_call() {
    let content = format!(
        "{}{}{}",
        assistant_tool_call("call-1", "bash"),
        session_exit(Some("sighup")),
        user_message()
    );
    let file = write_scratch(&content).await;
    let result = detect_unexpected_termination(Some(&file)).await;
    assert!(is_clean(&result));
}

#[tokio::test]
async fn a_crashed_life_resumed_and_crashed_again_only_the_latest_exit_record_counts() {
    let content = format!(
        "{}{}{}{}",
        session_exit(Some("dispose")),
        user_message(),
        assistant_tool_call("call-2", "bash"),
        session_exit(Some("sighup"))
    );
    let file = write_scratch(&content).await;
    let result = detect_unexpected_termination(Some(&file)).await;
    assert!(result.terminated_unexpectedly);
}

#[tokio::test]
async fn only_reads_the_tail_an_unmatched_call_before_the_window_is_never_seen() {
    let padding = "x".repeat(2048);
    let padding_lines: String = (0..200)
        .map(|_| line(json!({ "type": "notice", "padding": padding })))
        .collect();
    let content = format!(
        "{}{}{}{}",
        assistant_tool_call("call-0", "bash"),
        padding_lines,
        assistant_tool_call("call-1", "bash"),
        tool_result("call-1")
    );
    let file = write_scratch(&content).await;
    let result = detect_unexpected_termination(Some(&file)).await;
    assert!(is_clean(&result));
}

#[tokio::test]
async fn expands_the_window_for_a_single_line_bigger_than_the_tail_window() {
    let huge_argument = "y".repeat(300 * 1024);
    let content = format!(
        "{}{}",
        assistant_tool_call("call-1", "write"),
        line(
            json!({ "type": "message", "message": { "role": "assistant", "content": [{ "type": "toolCall", "id": "call-2", "name": "write", "arguments": { "content": huge_argument } }] } })
        )
    );
    let file = write_scratch(&content).await;
    let result = detect_unexpected_termination(Some(&file)).await;
    assert!(result.terminated_unexpectedly);
    let mut names = result.pending_tool_names.clone();
    names.sort();
    assert_eq!(names, vec!["write".to_string(), "write".to_string()]);
}

#[tokio::test]
async fn tolerates_crlf_line_endings() {
    let content =
        (assistant_tool_call("call-1", "bash") + &tool_result("call-1")).replace('\n', "\r\n");
    let file = write_scratch(&content).await;
    let result = detect_unexpected_termination(Some(&file)).await;
    assert!(is_clean(&result));
}

#[tokio::test]
async fn handles_a_window_boundary_mid_multibyte_utf8_character() {
    let padding = "éèê".repeat(1024);
    let padding_lines: String = (0..150)
        .map(|_| line(json!({ "type": "notice", "padding": padding })))
        .collect();
    let content = format!(
        "{}{}{}",
        padding_lines,
        assistant_tool_call("call-1", "bash"),
        tool_result("call-1")
    );
    let file = write_scratch(&content).await;
    let result = detect_unexpected_termination(Some(&file)).await;
    assert!(is_clean(&result));
}

#[tokio::test]
async fn judges_a_hard_killed_life_on_its_own_once_a_later_user_message_starts_a_new_one() {
    let content = format!(
        "{}{}{}{}",
        assistant_tool_call("call-1", "bash"),
        user_message(),
        assistant_tool_call("call-2", "bash"),
        tool_result("call-2")
    );
    let file = write_scratch(&content).await;
    let result = detect_unexpected_termination(Some(&file)).await;
    assert!(is_clean(&result));
}

#[tokio::test]
async fn caches_by_file_size_mtime_a_later_append_is_detected_not_stale() {
    let content = format!(
        "{}{}",
        assistant_tool_call("call-1", "bash"),
        tool_result("call-1")
    );
    let file = write_scratch(&content).await;
    let first = detect_unexpected_termination(Some(&file)).await;
    assert!(is_clean(&first));
    // Ensure the mtime actually advances on filesystems with coarse timestamp resolution.
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    let mut appended = tokio::fs::OpenOptions::new()
        .append(true)
        .open(&file)
        .await
        .unwrap();
    tokio::io::AsyncWriteExt::write_all(
        &mut appended,
        assistant_tool_call("call-2", "bash").as_bytes(),
    )
    .await
    .unwrap();
    appended.sync_all().await.unwrap();
    drop(appended);
    let second = detect_unexpected_termination(Some(&file)).await;
    assert!(second.terminated_unexpectedly);
    assert_eq!(second.pending_tool_names, vec!["bash".to_string()]);
}

#[tokio::test]
async fn caches_by_file_size_mtime_a_deleted_file_reports_clean_and_evicts() {
    let content = assistant_tool_call("call-1", "bash");
    let file = write_scratch(&content).await;
    let first = detect_unexpected_termination(Some(&file)).await;
    assert!(first.terminated_unexpectedly);
    tokio::fs::remove_file(&file).await.unwrap();
    let second = detect_unexpected_termination(Some(&file)).await;
    assert!(is_clean(&second));
}

#[tokio::test]
async fn excludes_an_earlier_lifes_orphaned_call_from_a_later_still_unmatched_ones_names() {
    let content = format!(
        "{}{}{}",
        assistant_tool_call("call-1", "eval"),
        user_message(),
        assistant_tool_call("call-2", "bash")
    );
    let file = write_scratch(&content).await;
    let result = detect_unexpected_termination(Some(&file)).await;
    assert!(result.terminated_unexpectedly);
    assert_eq!(result.pending_tool_names, vec!["bash".to_string()]);
}

// -------------------------------------------------------------------------------------------
// Marker tests (port of `stoppedOnRequestMarker.test.ts`'s own pure-validation cases; the
// record/clear write paths go through `SessionAgent::registry()`, exercised instead via
// `is_stopped_on_request_marker_valid`/`resolve_termination_for` directly against a `Session`
// fixture -- no live `SessionAgent` construction needed for these).
// -------------------------------------------------------------------------------------------

fn make_session(
    current_conversation: Option<&str>,
    marker_conversation: Option<&str>,
    marker_size: Option<i64>,
) -> Session {
    Session {
        id: "session-1".to_string(),
        repository_id: "repo-1".to_string(),
        name: "test".to_string(),
        branch: "feat/test".to_string(),
        base_branch: "main".to_string(),
        worktree_path: "C:/repos/x".to_string(),
        session_dir: None,
        current_conversation: current_conversation.map(str::to_string),
        last_message_count: None,
        last_model: None,
        last_thinking_level: None,
        created_at: "2026-10-14T00:00:00.000Z".to_string(),
        last_activity_at: "2026-10-14T00:00:00.000Z".to_string(),
        archived_at: None,
        current_turn_subagents: None,
        stopped_on_request_conversation: marker_conversation.map(str::to_string),
        stopped_on_request_at_size: marker_size,
    }
}

#[tokio::test]
async fn marker_valid_when_conversation_and_size_both_match() {
    let file = write_scratch("hello").await;
    let size = tokio::fs::metadata(&file).await.unwrap().len() as i64;
    let session = make_session(Some(&file), Some(&file), Some(size));
    assert!(is_stopped_on_request_marker_valid(&session).await);
}

#[tokio::test]
async fn marker_invalid_once_the_file_has_grown() {
    let file = write_scratch("hello").await;
    let size = tokio::fs::metadata(&file).await.unwrap().len() as i64;
    tokio::fs::write(&file, "hello world, appended")
        .await
        .unwrap();
    let session = make_session(Some(&file), Some(&file), Some(size));
    assert!(!is_stopped_on_request_marker_valid(&session).await);
}

#[tokio::test]
async fn marker_invalid_when_no_current_conversation() {
    let session = make_session(None, Some("C:/whatever.jsonl"), Some(5));
    assert!(!is_stopped_on_request_marker_valid(&session).await);
}

#[tokio::test]
async fn marker_invalid_when_it_names_a_different_conversation() {
    let file = write_scratch("hello").await;
    let session = make_session(Some(&file), Some("C:/some-other-file.jsonl"), Some(5));
    assert!(!is_stopped_on_request_marker_valid(&session).await);
}

#[tokio::test]
async fn marker_invalid_with_no_marker_at_all() {
    let file = write_scratch("hello").await;
    let session = make_session(Some(&file), None, None);
    assert!(!is_stopped_on_request_marker_valid(&session).await);
}

#[tokio::test]
async fn resolve_termination_is_clean_when_stopped_on_request_flag_is_set() {
    let session = make_session(Some("C:/does-not-matter.jsonl"), None, None);
    let result = resolve_termination_for(&session, true).await;
    assert!(is_clean(&result));
}

#[tokio::test]
async fn resolve_termination_is_clean_when_the_persisted_marker_is_valid() {
    let file = write_scratch(&assistant_tool_call("call-1", "bash")).await;
    let size = tokio::fs::metadata(&file).await.unwrap().len() as i64;
    let session = make_session(Some(&file), Some(&file), Some(size));
    let result = resolve_termination_for(&session, false).await;
    assert!(is_clean(&result));
}

#[tokio::test]
async fn resolve_termination_falls_through_to_the_tail_read_otherwise() {
    let file = write_scratch(&assistant_tool_call("call-1", "bash")).await;
    let session = make_session(Some(&file), None, None);
    let result = resolve_termination_for(&session, false).await;
    assert!(result.terminated_unexpectedly);
    assert_eq!(result.pending_tool_names, vec!["bash".to_string()]);
}
