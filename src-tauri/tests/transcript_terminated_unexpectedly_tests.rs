// Issue #795 (lane R12b): direct ports of `src/main/omp/transcript.test.ts`'s
// `describe('fromHistory terminatedUnexpectedly gating', ...)` 4 named `it(...)` cases (that
// file's lines 15, 21, 27, 41) -- gate-round-2 HIGH #2 remediation. The previous round's 7
// scenario pairs under `scripts/fixtures/transcript-golden/` (`thinking`, `isError`, `subagent`,
// `notice`, `hasUserActed`, `reset-on-removal`, `request`) were NOT ports of any named test case
// -- they were derived from reading `transcript.rs`'s own code paths, which is exactly what
// Stuart's rule forbids -- and have been removed along with their `#[test]` fns in
// `transcript_golden.rs`. These 4 are faithful ports of `transcript.test.ts`'s own
// `toolCallMessages()` helper and its 4 `it()` bodies, using inline `serde_json::json!` message
// literals (no fixture files) since the TS test itself builds its messages inline, not via a
// fixture.

use std::sync::Arc;

use refract_tauri_lib::omp::transcript::{ToolStatus, TranscriptItem, TranscriptState};
use serde_json::json;

/// Port of `transcript.test.ts`'s `toolCallMessages()` helper (lines 7-12): a single unresolved
/// `bash` tool call, `call-1`.
fn tool_call_messages() -> Vec<serde_json::Value> {
    vec![
        json!({ "role": "user", "content": [{ "type": "text", "text": "run it" }] }),
        json!({
            "role": "assistant",
            "content": [{ "type": "toolCall", "id": "call-1", "name": "bash", "arguments": {} }]
        }),
    ]
}

fn tool_statuses(items: &[Arc<TranscriptItem>]) -> Vec<ToolStatus> {
    items
        .iter()
        .filter_map(|item| match item.as_ref() {
            TranscriptItem::Tool { status, .. } => Some(*status),
            _ => None,
        })
        .collect()
}

/// Port of `transcript.test.ts:15` -- "leaves an unresolved tool call 'running' when
/// terminatedUnexpectedly is false (default)".
#[test]
fn leaves_unresolved_tool_call_running_when_terminated_unexpectedly_false_default() {
    let messages = tool_call_messages();
    let mut state = TranscriptState::from_history(&messages);
    state.settle_interrupted_tool_rows();
    assert_eq!(tool_statuses(state.items()), vec![ToolStatus::Running]);
}

/// Port of `transcript.test.ts:21` -- "settles an unresolved tool call to 'interrupted' when
/// terminatedUnexpectedly is true".
#[test]
fn settles_unresolved_tool_call_to_interrupted_when_terminated_unexpectedly_true() {
    let messages = tool_call_messages();
    let mut state = TranscriptState::from_history(&messages);
    state.set_terminated_unexpectedly(true);
    state.settle_interrupted_tool_rows();
    assert_eq!(tool_statuses(state.items()), vec![ToolStatus::Interrupted]);
}

/// Port of `transcript.test.ts:27` -- "leaves a RESOLVED tool call 'done' even when
/// terminatedUnexpectedly is true".
#[test]
fn leaves_resolved_tool_call_done_even_when_terminated_unexpectedly_true() {
    let mut messages = tool_call_messages();
    messages.push(json!({
        "role": "toolResult",
        "toolCallId": "call-1",
        "toolName": "bash",
        "content": [{ "type": "text", "text": "ok" }]
    }));
    let mut state = TranscriptState::from_history(&messages);
    state.set_terminated_unexpectedly(true);
    state.settle_interrupted_tool_rows();
    assert_eq!(tool_statuses(state.items()), vec![ToolStatus::Done]);
}

/// Port of `transcript.test.ts:41` -- "settles an EARLIER orphaned call to 'interrupted' when a
/// later user message starts a new life, even though terminatedUnexpectedly is false overall".
#[test]
fn settles_earlier_orphaned_call_to_interrupted_on_later_user_message_even_when_overall_false() {
    let messages = vec![
        json!({ "role": "user", "content": [{ "type": "text", "text": "first" }] }),
        json!({
            "role": "assistant",
            "content": [{ "type": "toolCall", "id": "call-1", "name": "bash", "arguments": {} }]
        }),
        json!({ "role": "user", "content": [{ "type": "text", "text": "second" }] }),
        json!({
            "role": "assistant",
            "content": [{ "type": "toolCall", "id": "call-2", "name": "bash", "arguments": {} }]
        }),
        json!({
            "role": "toolResult",
            "toolCallId": "call-2",
            "toolName": "bash",
            "content": [{ "type": "text", "text": "ok" }]
        }),
    ];
    let mut state = TranscriptState::from_history(&messages);
    state.set_terminated_unexpectedly(false);
    state.settle_interrupted_tool_rows();

    assert_eq!(
        tool_statuses(state.items()),
        vec![ToolStatus::Interrupted, ToolStatus::Done]
    );
}
