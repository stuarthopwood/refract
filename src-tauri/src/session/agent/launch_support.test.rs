// Unit tests for `session::agent::launch_support` (lane R3, issue #786, gate round 2 finding):
// `#[path]`-loaded sibling of `launch_support.rs` (excluded from `check:file-size` by its own
// `.test.rs` name), mirroring the `ipc::sessions_agent.rs` -> `sessions_agent.test.rs` split.
//
// Ports `verify_reattach`'s own 4 cases from `reattachVerification.test.ts`'s `describe('verifyReattach', ...)`
// block, `reattach_rebaseline_notice`'s own 3 cases from that same file's `describe(
// 'reattachRebaselineNotice', ...)` block, and all 19 `fetchAllMessages.test.ts` cases against
// `fetch_all_messages_core`/`fallback_to_get_messages_core` (the generic `_core` functions
// `MessagesPageRequester` makes testable without a real spawned `omp` process -- see
// `launch_support.rs`'s own doc comment on that trait for the refactor this required).
//
// NOT ported: `reattachVerification.test.ts`'s own `assertConversationFileExists` (2 cases).
// Its exact behaviour is already inlined directly in `launch.rs`'s `attach_and_verify` (a plain
// `tokio::fs::metadata` check before `switch_session`), never extracted as its own function in
// this file -- nothing here to unit-test in isolation.
use super::*;
use std::sync::Mutex as StdMutex;

// ---------------------------------------------------------------------------------------------
// verify_reattach -- port of reattachVerification.test.ts's own `describe('verifyReattach', ...)`
// ---------------------------------------------------------------------------------------------

#[test]
fn verify_reattach_passes_a_matching_file_with_a_positive_message_count() {
    let state = json!({ "sessionFile": "C:/sessions/swift-otter/conv.jsonl", "messageCount": 446 });
    assert!(verify_reattach("C:/sessions/swift-otter/conv.jsonl", &state).is_ok());
}

/// TS case: "passes even when messageCount dropped below lastMessageCount (compaction, slice
/// 5)". `verify_reattach` never sees `lastMessageCount` at all (the rebaseline decision lives
/// elsewhere -- see this file's final report), so the only portable half of that case is that a
/// lower-but-still-positive `messageCount` is not itself a failure.
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

// ---------------------------------------------------------------------------------------------
// reattach_rebaseline_notice -- port of reattachVerification.test.ts's own
// `describe('reattachRebaselineNotice', ...)` block
// ---------------------------------------------------------------------------------------------

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
        current_turn_subagents: None,
        stopped_on_request_conversation: None,
        stopped_on_request_at_size: None,
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

// ---------------------------------------------------------------------------------------------
// fetch_all_messages_core / fallback_to_get_messages_core -- port of fetchAllMessages.test.ts
// ---------------------------------------------------------------------------------------------

fn user_message(text: &str) -> Value {
    json!({ "role": "user", "content": [{ "type": "text", "text": text }] })
}

/// Port of `fetchAllMessages.test.ts`'s own `fakeServer`: paginates a fixed in-memory message
/// array exactly the way the real server was observed to (FINDINGS item 47) -- `limit` honoured,
/// `cursor` a plain opaque offset-as-string this fake itself issues and expects back verbatim --
/// and also answers a plain `get_messages` the same fallback path needs.
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

/// Port of "never sends the offset field (confirmed-dead parameter, FINDINGS item 47)". The
/// Rust `fetch_all_messages_core` command literal structurally never includes an `offset` key
/// at all (unlike the TS source, which has to actively avoid spreading one in); this spy keeps
/// the regression guard in place as a behavioural assertion rather than relying on that being
/// forever true by construction.
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

/// Port of the "flaky" fake both LATER-page cases (throws / malformed) share: answers for real
/// via `fake_server_response` on every call except the `fail_at`-th, where it fails the
/// configured way instead.
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

/// Port of the "broken first page, fallback succeeds" fakes (quality-gate cycle 2/3 cases):
/// fails the very first `get_messages_page` the configured way, answers every other command
/// (including the `get_messages` fallback) for real via `fake_server_response`.
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

/// Port of "reports incomplete when nextCursor disappears before totalMessages is reached":
/// claims 450 total but stops offering a cursor after the first page of `MESSAGES_PAGE_SIZE` --
/// a server bug, or (hypothetically) a Conversation that shrank mid-fetch.
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
