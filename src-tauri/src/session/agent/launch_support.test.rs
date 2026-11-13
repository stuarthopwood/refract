// Unit tests for `launch_support`, loaded via `#[path]` from `launch_support.rs`.
use super::*;
use std::sync::Mutex as StdMutex;

#[tokio::test]
async fn assert_conversation_file_exists_resolves_for_a_file_that_exists() {
    let file = crate::test_scratch::path(format!(
        "refract-assert-conv-exists-test-{}.jsonl",
        uuid::Uuid::new_v4()
    ));
    tokio::fs::write(&file, "{}\n").await.unwrap();
    let result = assert_conversation_file_exists(file.to_str().unwrap()).await;
    tokio::fs::remove_file(&file).await.ok();
    assert!(result.is_ok());
}

#[tokio::test]
async fn assert_conversation_file_exists_throws_naming_the_path_for_a_missing_file() {
    let file = crate::test_scratch::path(format!(
        "refract-assert-conv-missing-test-{}.jsonl",
        uuid::Uuid::new_v4()
    ));
    let missing = file.to_str().unwrap().to_string();
    let result = assert_conversation_file_exists(&missing).await;
    match result {
        Err(message) => assert!(
            message.contains(&missing),
            "error must name the missing path, got: {message}"
        ),
        Ok(()) => panic!("expected an error for a missing file"),
    }
}

#[test]
fn verify_reattach_passes_a_matching_file_with_a_positive_message_count() {
    let state = json!({ "sessionFile": "C:/sessions/swift-otter/conv.jsonl", "messageCount": 446 });
    assert!(verify_reattach("C:/sessions/swift-otter/conv.jsonl", &state).is_ok());
}

/// A `messageCount` dropping below the last count (compaction) is not a failure here.
/// The rebaseline decision lives outside `verify_reattach`.
#[test]
fn verify_reattach_passes_with_a_message_count_lower_than_before() {
    let state = json!({ "sessionFile": "C:/sessions/swift-otter/conv.jsonl", "messageCount": 300 });
    assert!(verify_reattach("C:/sessions/swift-otter/conv.jsonl", &state).is_ok());
}

#[test]
fn verify_reattach_fails_on_a_session_file_mismatch() {
    let state =
        json!({ "sessionFile": "C:/sessions/swift-otter/different.jsonl", "messageCount": 446 });
    let err = verify_reattach("C:/sessions/swift-otter/conv.jsonl", &state).unwrap_err();
    assert!(err.contains("sessionFile mismatch"), "{err}");
}

#[test]
fn verify_reattach_fails_on_a_zero_message_count() {
    let state = json!({ "sessionFile": "C:/sessions/swift-otter/conv.jsonl", "messageCount": 0 });
    let err = verify_reattach("C:/sessions/swift-otter/conv.jsonl", &state).unwrap_err();
    assert!(err.contains("messageCount is 0"), "{err}");
}

fn make_session_for_notice(last_message_count: Option<i64>) -> crate::store::registry::Session {
    crate::store::registry::Session {
        id: "session-1".to_string(),
        repository_id: "repo-1".to_string(),
        name: "test".to_string(),
        branch: "feat/test".to_string(),
        base_branch: "main".to_string(),
        worktree_path: "C:/repos/x".to_string(),
        session_dir: None,
        current_conversation: Some("C:/sessions/swift-otter/conv.jsonl".to_string()),
        last_message_count,
        last_model: None,
        last_thinking_level: None,
        created_at: "2026-10-14T00:00:00.000Z".to_string(),
        last_activity_at: "2026-10-14T00:00:00.000Z".to_string(),
        archived_at: None,
        hidden_at: None,
        paused_held: None,
        current_turn_subagents: None,
        stopped_on_request_conversation: None,
        stopped_on_request_at_size: None,
        pinned_model: false,
        origin_issue: None,
        parent_session_id: None,
    }
}

#[test]
fn reattach_rebaseline_notice_is_silent_when_last_message_count_is_null() {
    let session = make_session_for_notice(None);
    let state = json!({ "messageCount": 10 });
    assert_eq!(reattach_rebaseline_notice(&session, &state), None);
}

#[test]
fn reattach_rebaseline_notice_is_silent_when_the_count_did_not_drop() {
    let session = make_session_for_notice(Some(446));
    assert_eq!(
        reattach_rebaseline_notice(&session, &json!({ "messageCount": 446 })),
        None
    );
    assert_eq!(
        reattach_rebaseline_notice(&session, &json!({ "messageCount": 500 })),
        None
    );
}

#[test]
fn reattach_rebaseline_notice_names_both_counts_when_compaction_lowers_the_observed_count() {
    let session = make_session_for_notice(Some(446));
    let notice = reattach_rebaseline_notice(&session, &json!({ "messageCount": 300 })).unwrap();
    assert!(notice.contains("300 messages"), "{notice}");
    assert!(notice.contains("446"), "{notice}");
}

fn user_message(text: &str) -> Value {
    json!({ "role": "user", "content": [{ "type": "text", "text": text }] })
}

/// Paginates a fixed message array the way the real server does: `limit` honoured,
/// `cursor` an opaque offset string. Also answers `get_messages` for the fallback path.
fn fake_server_response(messages: &[Value], cmd: &Value) -> Value {
    let cmd_type = cmd.get("type").and_then(Value::as_str).unwrap_or("");
    if cmd_type == "get_messages" {
        return json!({ "type": "response", "command": "get_messages", "success": true, "data": { "messages": messages } });
    }
    assert_eq!(
        cmd_type, "get_messages_page",
        "unexpected command {cmd_type}"
    );
    let limit = cmd.get("limit").and_then(Value::as_u64).unwrap_or(0) as usize;
    let start = cmd
        .get("cursor")
        .and_then(Value::as_str)
        .and_then(|c| c.parse::<usize>().ok())
        .unwrap_or(0);
    let end = (start + limit).min(messages.len());
    let page = messages[start..end].to_vec();
    let mut data = json!({ "messages": page, "totalMessages": messages.len() });
    if end < messages.len() {
        data["nextCursor"] = Value::String(end.to_string());
    }
    json!({ "type": "response", "command": "get_messages_page", "success": true, "data": data })
}

struct FakeServer {
    messages: Vec<Value>,
}

impl MessagesPageRequester for FakeServer {
    async fn request_frame(&self, cmd: Value, _timeout_ms: u64) -> Result<Value, String> {
        Ok(fake_server_response(&self.messages, &cmd))
    }
}

#[tokio::test]
async fn returns_everything_in_one_page_when_it_all_fits_under_the_page_size() {
    let messages = vec![user_message("a"), user_message("b"), user_message("c")];
    let server = FakeServer {
        messages: messages.clone(),
    };
    let (result_messages, complete) = fetch_all_messages_core(&server).await;
    assert!(complete);
    assert_eq!(result_messages, messages);
}

#[tokio::test]
async fn reports_an_empty_history_as_complete() {
    let server = FakeServer {
        messages: Vec::new(),
    };
    let (result_messages, complete) = fetch_all_messages_core(&server).await;
    assert!(complete);
    assert!(result_messages.is_empty());
}

#[tokio::test]
async fn follows_next_cursor_across_multiple_pages_and_assembles_them_in_order() {
    let messages: Vec<Value> = (0..450)
        .map(|i| user_message(&format!("msg-{i}")))
        .collect();
    let server = FakeServer {
        messages: messages.clone(),
    };
    let (result_messages, complete) = fetch_all_messages_core(&server).await;
    assert!(complete);
    assert_eq!(result_messages.len(), 450);
    assert_eq!(result_messages, messages);
}

/// Records the commands sent, so a test can assert none carries an `offset` field.
/// Keeps the regression guard behavioural rather than relying on the literal's shape.
struct OffsetSpy {
    messages: Vec<Value>,
    saw_offset: StdMutex<bool>,
}

impl MessagesPageRequester for OffsetSpy {
    async fn request_frame(&self, cmd: Value, _timeout_ms: u64) -> Result<Value, String> {
        if cmd.get("offset").is_some() {
            *self.saw_offset.lock().unwrap() = true;
        }
        Ok(fake_server_response(&self.messages, &cmd))
    }
}

#[tokio::test]
async fn never_sends_the_offset_field() {
    let spy = OffsetSpy {
        messages: vec![user_message("a")],
        saw_offset: StdMutex::new(false),
    };
    fetch_all_messages_core(&spy).await;
    assert!(!*spy.saw_offset.lock().unwrap());
}

enum FlakyFailure {
    Throw,
    MalformedMissingMessages,
}

/// Answers for real on every call except the `fail_at`-th, which fails as configured.
struct FlakyAtCall {
    messages: Vec<Value>,
    calls: StdMutex<u32>,
    fail_at: u32,
    failure: FlakyFailure,
}

impl MessagesPageRequester for FlakyAtCall {
    async fn request_frame(&self, cmd: Value, _timeout_ms: u64) -> Result<Value, String> {
        let call = {
            let mut calls = self.calls.lock().unwrap();
            *calls += 1;
            *calls
        };
        if call == self.fail_at {
            return match self.failure {
                FlakyFailure::Throw => Err("network blip".to_string()),
                FlakyFailure::MalformedMissingMessages => Ok(json!({
                    "type": "response",
                    "command": "get_messages_page",
                    "success": true,
                    "data": { "totalMessages": 450 },
                })),
            };
        }
        Ok(fake_server_response(&self.messages, &cmd))
    }
}

#[tokio::test]
async fn returns_incomplete_with_the_partial_messages_already_fetched_when_a_later_page_throws() {
    let messages: Vec<Value> = (0..450)
        .map(|i| user_message(&format!("msg-{i}")))
        .collect();
    let flaky = FlakyAtCall {
        messages,
        calls: StdMutex::new(0),
        fail_at: 2,
        failure: FlakyFailure::Throw,
    };
    let (result_messages, complete) = fetch_all_messages_core(&flaky).await;
    assert!(!complete);
    assert_eq!(result_messages.len(), MESSAGES_PAGE_SIZE as usize);
}

#[tokio::test]
async fn returns_incomplete_with_the_partial_messages_already_fetched_when_a_later_page_is_malformed(
) {
    let messages: Vec<Value> = (0..450)
        .map(|i| user_message(&format!("msg-{i}")))
        .collect();
    let flaky = FlakyAtCall {
        messages,
        calls: StdMutex::new(0),
        fail_at: 2,
        failure: FlakyFailure::MalformedMissingMessages,
    };
    let (result_messages, complete) = fetch_all_messages_core(&flaky).await;
    assert!(!complete);
    assert_eq!(result_messages.len(), MESSAGES_PAGE_SIZE as usize);
}

enum BrokenFirstPageKind {
    Throws,
    SuccessFalse,
    MalformedMessagesNotArray,
    DataMissing,
    MissingTotalMessages,
}

/// Fails the first page request as configured, and answers every other command for real.
struct BrokenFirstPage {
    messages: Vec<Value>,
    kind: BrokenFirstPageKind,
}

impl MessagesPageRequester for BrokenFirstPage {
    async fn request_frame(&self, cmd: Value, _timeout_ms: u64) -> Result<Value, String> {
        if cmd.get("type").and_then(Value::as_str) == Some("get_messages_page") {
            return match self.kind {
                BrokenFirstPageKind::Throws => Err("unknown command".to_string()),
                BrokenFirstPageKind::SuccessFalse => Ok(json!({
                    "type": "response",
                    "command": "get_messages_page",
                    "success": false,
                    "error": "unknown command",
                })),
                BrokenFirstPageKind::MalformedMessagesNotArray => Ok(json!({
                    "type": "response",
                    "command": "get_messages_page",
                    "success": true,
                    "data": { "messages": "not-an-array", "totalMessages": 1 },
                })),
                BrokenFirstPageKind::DataMissing => Ok(json!({
                    "type": "response",
                    "command": "get_messages_page",
                    "success": true,
                })),
                BrokenFirstPageKind::MissingTotalMessages => Ok(json!({
                    "type": "response",
                    "command": "get_messages_page",
                    "success": true,
                    "data": { "messages": self.messages.clone() },
                })),
            };
        }
        Ok(fake_server_response(&self.messages, &cmd))
    }
}

#[tokio::test]
async fn falls_back_to_get_messages_when_the_first_page_throws_and_the_fallback_succeeds() {
    let messages = vec![user_message("a"), user_message("b")];
    let broken = BrokenFirstPage {
        messages: messages.clone(),
        kind: BrokenFirstPageKind::Throws,
    };
    let (result_messages, complete) = fetch_all_messages_core(&broken).await;
    assert!(complete);
    assert_eq!(result_messages, messages);
}

#[tokio::test]
async fn falls_back_to_get_messages_when_the_first_page_responds_success_false_and_the_fallback_succeeds(
) {
    let messages = vec![user_message("a")];
    let broken = BrokenFirstPage {
        messages: messages.clone(),
        kind: BrokenFirstPageKind::SuccessFalse,
    };
    let (result_messages, complete) = fetch_all_messages_core(&broken).await;
    assert!(complete);
    assert_eq!(result_messages, messages);
}

#[tokio::test]
async fn falls_back_to_get_messages_when_the_first_page_is_malformed_non_array_messages_and_the_fallback_succeeds(
) {
    let messages = vec![user_message("a")];
    let broken = BrokenFirstPage {
        messages: messages.clone(),
        kind: BrokenFirstPageKind::MalformedMessagesNotArray,
    };
    let (result_messages, complete) = fetch_all_messages_core(&broken).await;
    assert!(complete);
    assert_eq!(result_messages, messages);
}

struct AllFail;

impl MessagesPageRequester for AllFail {
    async fn request_frame(&self, cmd: Value, _timeout_ms: u64) -> Result<Value, String> {
        let cmd_type = cmd
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        Ok(json!({ "type": "response", "command": cmd_type, "success": false, "error": "boom" }))
    }
}

#[tokio::test]
async fn returns_incomplete_empty_messages_when_both_the_first_page_and_its_fallback_fail() {
    let (result_messages, complete) = fetch_all_messages_core(&AllFail).await;
    assert!(!complete);
    assert!(result_messages.is_empty());
}

struct BrokenEverythingThrows;

impl MessagesPageRequester for BrokenEverythingThrows {
    async fn request_frame(&self, cmd: Value, _timeout_ms: u64) -> Result<Value, String> {
        if cmd.get("type").and_then(Value::as_str) == Some("get_messages_page") {
            Err("unknown command".to_string())
        } else {
            Err("get_messages also unreachable".to_string())
        }
    }
}

#[tokio::test]
async fn returns_incomplete_empty_messages_when_the_first_page_fails_and_its_fallback_itself_throws(
) {
    let (result_messages, complete) = fetch_all_messages_core(&BrokenEverythingThrows).await;
    assert!(!complete);
    assert!(result_messages.is_empty());
}

struct BrokenEverythingMalformedFallback;

impl MessagesPageRequester for BrokenEverythingMalformedFallback {
    async fn request_frame(&self, cmd: Value, _timeout_ms: u64) -> Result<Value, String> {
        if cmd.get("type").and_then(Value::as_str) == Some("get_messages_page") {
            Err("unknown command".to_string())
        } else {
            Ok(json!({
                "type": "response",
                "command": "get_messages",
                "success": true,
                "data": { "messages": "not-an-array" },
            }))
        }
    }
}

#[tokio::test]
async fn returns_incomplete_empty_messages_when_the_first_page_fails_and_its_fallback_returns_non_array_messages(
) {
    let (result_messages, complete) =
        fetch_all_messages_core(&BrokenEverythingMalformedFallback).await;
    assert!(!complete);
    assert!(result_messages.is_empty());
}

#[tokio::test]
async fn falls_back_to_get_messages_when_the_first_page_responds_success_true_with_data_undefined()
{
    let messages = vec![user_message("a")];
    let broken = BrokenFirstPage {
        messages: messages.clone(),
        kind: BrokenFirstPageKind::DataMissing,
    };
    let (result_messages, complete) = fetch_all_messages_core(&broken).await;
    assert!(complete);
    assert_eq!(result_messages, messages);
}

#[tokio::test]
async fn falls_back_to_get_messages_when_the_first_page_is_missing_total_messages() {
    let messages = vec![user_message("a")];
    let broken = BrokenFirstPage {
        messages: messages.clone(),
        kind: BrokenFirstPageKind::MissingTotalMessages,
    };
    let (result_messages, complete) = fetch_all_messages_core(&broken).await;
    assert!(complete);
    assert_eq!(result_messages, messages);
}

struct Stubborn {
    messages: Vec<Value>,
}

impl MessagesPageRequester for Stubborn {
    async fn request_frame(&self, _cmd: Value, _timeout_ms: u64) -> Result<Value, String> {
        Ok(json!({
            "type": "response",
            "command": "get_messages_page",
            "success": true,
            "data": { "messages": self.messages, "nextCursor": "still-more", "totalMessages": self.messages.len() },
        }))
    }
}

#[tokio::test]
async fn stops_once_the_accumulated_count_reaches_total_messages_even_if_next_cursor_is_still_present(
) {
    let messages = vec![user_message("a"), user_message("b")];
    let stubborn = Stubborn {
        messages: messages.clone(),
    };
    let (result_messages, complete) = fetch_all_messages_core(&stubborn).await;
    assert!(complete);
    assert_eq!(result_messages, messages);
}

/// Claims 450 total but stops offering a cursor after the first page: the fetch must report incomplete.
struct DroppedCursor {
    page1: Vec<Value>,
    calls: StdMutex<u32>,
}

impl MessagesPageRequester for DroppedCursor {
    async fn request_frame(&self, _cmd: Value, _timeout_ms: u64) -> Result<Value, String> {
        let call = {
            let mut calls = self.calls.lock().unwrap();
            *calls += 1;
            *calls
        };
        let messages = if call == 1 {
            self.page1.clone()
        } else {
            Vec::new()
        };
        Ok(json!({
            "type": "response",
            "command": "get_messages_page",
            "success": true,
            "data": { "messages": messages, "totalMessages": 450 },
        }))
    }
}

#[tokio::test]
async fn reports_incomplete_when_next_cursor_disappears_before_total_messages_is_reached() {
    let page1: Vec<Value> = (0..MESSAGES_PAGE_SIZE)
        .map(|i| user_message(&format!("msg-{i}")))
        .collect();
    let dropped = DroppedCursor {
        page1,
        calls: StdMutex::new(0),
    };
    let (result_messages, complete) = fetch_all_messages_core(&dropped).await;
    assert!(!complete);
    assert_eq!(result_messages.len(), MESSAGES_PAGE_SIZE as usize);
}

struct EmptyPageWithCursor {
    calls: StdMutex<u32>,
}

impl MessagesPageRequester for EmptyPageWithCursor {
    async fn request_frame(&self, _cmd: Value, _timeout_ms: u64) -> Result<Value, String> {
        *self.calls.lock().unwrap() += 1;
        Ok(json!({
            "type": "response",
            "command": "get_messages_page",
            "success": true,
            "data": { "messages": Vec::<Value>::new(), "nextCursor": "loop-forever", "totalMessages": 999_999_999u64 },
        }))
    }
}

#[tokio::test]
async fn stops_immediately_one_request_when_a_page_is_empty_but_still_offers_a_cursor() {
    let stuck = EmptyPageWithCursor {
        calls: StdMutex::new(0),
    };
    let (_result_messages, complete) = fetch_all_messages_core(&stuck).await;
    assert!(!complete);
    assert_eq!(*stuck.calls.lock().unwrap(), 1);
}

struct SameCursorTwice {
    page1: Vec<Value>,
    calls: StdMutex<u32>,
}

impl MessagesPageRequester for SameCursorTwice {
    async fn request_frame(&self, _cmd: Value, _timeout_ms: u64) -> Result<Value, String> {
        *self.calls.lock().unwrap() += 1;
        Ok(json!({
            "type": "response",
            "command": "get_messages_page",
            "success": true,
            "data": { "messages": self.page1, "nextCursor": "same-cursor-every-time", "totalMessages": 999_999_999u64 },
        }))
    }
}

#[tokio::test]
async fn stops_on_the_second_request_when_the_exact_same_cursor_is_offered_twice() {
    let stuck = SameCursorTwice {
        page1: vec![user_message("a")],
        calls: StdMutex::new(0),
    };
    let (result_messages, complete) = fetch_all_messages_core(&stuck).await;
    assert!(!complete);
    assert_eq!(*stuck.calls.lock().unwrap(), 2);
    assert_eq!(result_messages.len(), 1);
}

struct NeverEnding {
    calls: StdMutex<u32>,
}

impl MessagesPageRequester for NeverEnding {
    async fn request_frame(&self, _cmd: Value, _timeout_ms: u64) -> Result<Value, String> {
        let call = {
            let mut calls = self.calls.lock().unwrap();
            *calls += 1;
            *calls
        };
        Ok(json!({
            "type": "response",
            "command": "get_messages_page",
            "success": true,
            "data": {
                "messages": [user_message(&format!("msg-{call}"))],
                "nextCursor": format!("cursor-{call}"),
                "totalMessages": 999_999_999u64,
            },
        }))
    }
}

#[tokio::test]
async fn gives_up_after_the_safety_cap_when_a_server_keeps_genuinely_paginating_but_never_reaches_total_messages(
) {
    let never_ending = NeverEnding {
        calls: StdMutex::new(0),
    };
    let (_result_messages, complete) = fetch_all_messages_core(&never_ending).await;
    assert!(!complete);
    assert_eq!(*never_ending.calls.lock().unwrap(), MAX_MESSAGE_PAGES);
}
