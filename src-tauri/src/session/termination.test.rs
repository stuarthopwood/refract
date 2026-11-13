// Unit tests for `session::termination`: tail parsing, per-life judgement, cache and marker.
// Scratch files go under the OS temp dir (never the repo) and are left in place: names are unique.
use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};

static SCRATCH_COUNTER: AtomicU64 = AtomicU64::new(0);

async fn write_scratch(content: &str) -> String {
    let n = SCRATCH_COUNTER.fetch_add(1, Ordering::Relaxed);
    let file = crate::test_scratch::path(format!(
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
    let missing = crate::test_scratch::path("refract-termination-test-does-not-exist.jsonl");
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

// Marker tests: pure validation against a `Session` fixture, no live agent needed.

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
        hidden_at: None,
        paused_held: None,
        current_turn_subagents: None,
        stopped_on_request_conversation: marker_conversation.map(str::to_string),
        stopped_on_request_at_size: marker_size,
        pinned_model: false,
        origin_issue: None,
        parent_session_id: None,
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
async fn marker_invalid_when_the_conversation_file_no_longer_exists() {
    let file = crate::test_scratch::path(format!(
        "refract-marker-gone-{}.jsonl",
        uuid::Uuid::new_v4()
    ));
    let session = make_session(
        Some(&file.to_string_lossy()),
        Some(&file.to_string_lossy()),
        Some(0),
    );
    assert!(!is_stopped_on_request_marker_valid(&session).await);
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
    // An unmatched tool call makes this go red if the `stopped_on_request` short-circuit is
    // removed; a nonexistent file would read clean either way.
    let file = write_scratch(&assistant_tool_call("call-1", "bash")).await;
    let session = make_session(Some(&file), None, None);
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

#[tokio::test]
async fn marker_invalid_for_a_negative_size() {
    // A hand-edited or corrupt `registry.json` is never trusted (fails closed).
    let file = write_scratch("hello").await;
    let session = make_session(Some(&file), Some(&file), Some(-1));
    assert!(!is_stopped_on_request_marker_valid(&session).await);
}

// -------------------------------------------------------------------------------------------
// `record_/clear_stopped_on_request_marker` against a real agent and registry, staleness via epoch.

async fn make_marker_test_agent(
    label: &str,
    marker_conversation: Option<&str>,
    marker_size: Option<i64>,
) -> std::sync::Arc<SessionAgent> {
    let dir = crate::test_scratch::path(format!(
        "refract-termination-marker-agent-{label}-{}",
        uuid::Uuid::new_v4()
    ));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let session_id = format!("session-{label}");
    let mut session = make_session(None, marker_conversation, marker_size);
    session.id = session_id.clone();
    let mut registry_store = crate::store::registry::RegistryStore::open(&dir)
        .await
        .unwrap();
    registry_store
        .add_repository(crate::store::registry::Repository {
            id: "repo-1".to_string(),
            path: dir.to_string_lossy().into_owned(),
            name: "Test Repo".to_string(),
            default_branch: "main".to_string(),
            added_at: "2026-01-01T00:00:00.000Z".to_string(),
            color: None,
        })
        .await
        .unwrap();
    registry_store.add_session(session).await.unwrap();
    let registry = std::sync::Arc::new(tokio::sync::Mutex::new(registry_store));
    let settings = std::sync::Arc::new(tokio::sync::Mutex::new(
        crate::store::settings::SettingsStore::open(&dir)
            .await
            .unwrap(),
    ));
    let app_handle_slot = std::sync::Arc::new(std::sync::Mutex::new(None));
    let events = crate::events::EventSink::new(app_handle_slot, registry.clone());
    let manager = crate::session::manager::SessionManager::new(registry, settings, events);
    manager.get_or_create_agent(&session_id)
}

#[tokio::test]
async fn record_marker_writes_the_patch_when_still_current() {
    let agent = make_marker_test_agent("write", None, None).await;
    let file = write_scratch("hello").await;
    let epoch_at_exit = agent.with_termination_state(|s| s.epoch).await;
    record_stopped_on_request_marker(&agent, Some(&file), epoch_at_exit).await;
    let session = agent
        .registry()
        .lock()
        .await
        .get_session(agent.session_id())
        .cloned()
        .unwrap();
    assert_eq!(
        session.stopped_on_request_conversation.as_deref(),
        Some(file.as_str())
    );
    assert!(session.stopped_on_request_at_size.is_some());
}

#[tokio::test]
async fn record_marker_skips_the_write_once_a_newer_life_has_started() {
    // `epoch_at_exit` is stale: a concurrent Recover's clear already bumped the live epoch.
    let agent = make_marker_test_agent("stale", None, None).await;
    let file = write_scratch("hello").await;
    let stale_epoch = agent.with_termination_state(|s| s.epoch).await;
    agent.clear_stopped_on_request_marker().await; // bumps epoch past `stale_epoch`
    record_stopped_on_request_marker(&agent, Some(&file), stale_epoch).await;
    let session = agent
        .registry()
        .lock()
        .await
        .get_session(agent.session_id())
        .cloned()
        .unwrap();
    assert!(session.stopped_on_request_conversation.is_none());
    assert!(session.stopped_on_request_at_size.is_none());
}

#[tokio::test]
async fn record_marker_checks_still_current_after_the_stat_not_before() {
    // Races the calls so the epoch bump lands while `record`'s `fs::metadata` await is pending,
    // proving the `still_current` check runs after the stat, not before.
    let file = write_scratch("hello").await;
    let agent = make_marker_test_agent("race-after-stat", None, None).await;
    let epoch_at_exit = agent.with_termination_state(|s| s.epoch).await;
    tokio::join!(
        record_stopped_on_request_marker(&agent, Some(&file), epoch_at_exit),
        agent.clear_stopped_on_request_marker(),
    );
    let session = agent
        .registry()
        .lock()
        .await
        .get_session(agent.session_id())
        .cloned()
        .unwrap();
    assert!(
        session.stopped_on_request_conversation.is_none(),
        "epoch bump during the stat must still block the write"
    );
}

#[tokio::test]
async fn record_marker_records_nothing_when_conversation_is_none() {
    let agent = make_marker_test_agent("no-conv", None, None).await;
    let epoch_at_exit = agent.with_termination_state(|s| s.epoch).await;
    record_stopped_on_request_marker(&agent, None, epoch_at_exit).await;
    let session = agent
        .registry()
        .lock()
        .await
        .get_session(agent.session_id())
        .cloned()
        .unwrap();
    assert!(session.stopped_on_request_conversation.is_none());
}

#[tokio::test]
async fn record_marker_never_panics_when_the_conversation_file_is_missing() {
    let agent = make_marker_test_agent("missing-file", None, None).await;
    let missing = crate::test_scratch::path(format!(
        "refract-termination-marker-missing-{}.jsonl",
        uuid::Uuid::new_v4()
    ));
    let epoch_at_exit = agent.with_termination_state(|s| s.epoch).await;
    record_stopped_on_request_marker(&agent, Some(&missing.to_string_lossy()), epoch_at_exit).await;
    let session = agent
        .registry()
        .lock()
        .await
        .get_session(agent.session_id())
        .cloned()
        .unwrap();
    assert!(session.stopped_on_request_conversation.is_none());
}

#[tokio::test]
async fn clear_marker_clears_both_fields_and_bumps_the_epoch() {
    let file = write_scratch("hello").await;
    let size = tokio::fs::metadata(&file).await.unwrap().len() as i64;
    let agent = make_marker_test_agent("clear", Some(&file), Some(size)).await;
    let epoch_before = agent.with_termination_state(|s| s.epoch).await;
    agent.clear_stopped_on_request_marker().await;
    let session = agent
        .registry()
        .lock()
        .await
        .get_session(agent.session_id())
        .cloned()
        .unwrap();
    assert!(session.stopped_on_request_conversation.is_none());
    assert!(session.stopped_on_request_at_size.is_none());
    let epoch_after = agent.with_termination_state(|s| s.epoch).await;
    assert!(
        epoch_after > epoch_before,
        "a new life starting must bump the epoch"
    );
}
