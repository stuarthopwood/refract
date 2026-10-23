// Token guard, Session side (#1212, spec 021 Lane B): the post-turn shake and the per-Conversation
// model-call counter. Lane extension point like `advisor`: owns its `State` (held in `AgentState`
// via `with_token_guard_state`) and is called from `agent/frame.rs`, `agent/chat.rs` and the
// Conversation changes in `agent/conversations.rs`/`agent/launch.rs`. The pure decisions live in
// `omp::token_guard::{shake,counter}`.
//
// Shake: after a turn fully settles (`handle_turn_settled`, once per settle), a spawned task reads
// the context size fresh from `get_session_stats`; above 60k it sends `/shake` as a prompt through
// `request_rpc_if_idle`, so it never runs while a turn is active (a user prompt that wins the race
// refuses it). The shake's `command_output` frame is swallowed (`swallow_shake_output`), and the
// next user prompt awaits an in-flight shake for a bounded time (`await_shake`).

use std::time::Duration;

use serde_json::{json, Value};

use crate::omp::token_guard::counter::{self, CallCounter};
use crate::omp::token_guard::shake::{self, ShakeState};

use super::agent::SessionAgent;

const STATS_TIMEOUT_MS: u64 = 10_000;
const SHAKE_RPC_TIMEOUT_MS: u64 = 30_000;
const WAIT_POLL_MS: u64 = 50;

#[derive(Default)]
pub(super) struct State {
    shake: ShakeState,
    counter: CallCounter,
}

async fn emit_calls(agent: &SessionAgent) {
    let (conversation, calls) = agent
        .with_token_guard_state(|s| (s.counter.conversation, s.counter.calls))
        .await;
    agent
        .events()
        .emit_token_guard_calls(agent.session_id(), &format!("c{conversation}"), calls);
}

/// `agent/frame.rs` lane hook: counts one call per completed assistant message.
pub(super) async fn on_frame(agent: &SessionAgent, frame_type: &str, frame: &Value) {
    let Some(message) = counter::assistant_message_end(frame_type, frame) else {
        return;
    };
    agent
        .with_token_guard_state(|s| s.counter.record(message))
        .await;
    emit_calls(agent).await;
}

/// A new or opened Conversation: `history` is its loaded messages (`None` for a brand-new one or
/// when the history could not be read completely).
pub(super) async fn on_conversation_reset(agent: &SessionAgent, history: Option<&[Value]>) {
    let calls = history.map_or(0, counter::count_assistant_messages);
    agent
        .with_token_guard_state(|s| s.counter.reset(calls))
        .await;
    emit_calls(agent).await;
}

/// A (re)attach loaded this Conversation's history: re-derives the count without starting a new
/// Conversation.
pub(super) async fn on_history_loaded(agent: &SessionAgent, history: &[Value]) {
    let calls = counter::count_assistant_messages(history);
    agent
        .with_token_guard_state(|s| s.counter.set_calls(calls))
        .await;
    emit_calls(agent).await;
}

pub(super) async fn begin_summary_capture(agent: &SessionAgent) {
    agent
        .with_token_guard_state(|s| s.counter.begin_capture())
        .await;
}

pub(super) async fn end_summary_capture(agent: &SessionAgent) -> Option<String> {
    agent
        .with_token_guard_state(|s| s.counter.end_capture())
        .await
}

/// `agent/frame.rs`'s `command_output` arm: `true` when this frame is the shake's own reply.
pub(super) async fn swallow_shake_output(agent: &SessionAgent) -> bool {
    agent
        .with_token_guard_state(|s| std::mem::take(&mut s.shake.swallow_output))
        .await
}

/// `agent/chat.rs` hook: a user prompt waits (bounded) for an in-flight shake so it cannot race.
pub(super) async fn await_shake(agent: &SessionAgent) {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(shake::SHAKE_PROMPT_WAIT_MS);
    while agent.with_token_guard_state(|s| s.shake.in_flight).await {
        if tokio::time::Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(Duration::from_millis(WAIT_POLL_MS)).await;
    }
}

/// `agent/frame.rs` hook, called once per genuine settle with that settle's turn generation.
pub(super) async fn on_turn_settled(agent: &SessionAgent, settle_id: u64) {
    let claimed = agent
        .with_token_guard_state(|s| s.shake.claim(settle_id))
        .await;
    if !claimed {
        return;
    }
    let agent = agent.arc();
    tokio::spawn(async move { run_shake(&agent).await });
}

async fn run_shake(agent: &SessionAgent) {
    let stats = agent
        .request_rpc(json!({ "type": "get_session_stats" }), STATS_TIMEOUT_MS)
        .await;
    let tokens = stats
        .ok()
        .filter(|res| res.get("success").and_then(Value::as_bool) == Some(true))
        .and_then(|res| res.get("data").and_then(shake::context_tokens_from_stats));
    if !shake::exceeds_threshold(tokens) {
        return;
    }
    let listed = agent
        .available_commands()
        .await
        .iter()
        .any(|c| c.get("name").and_then(Value::as_str) == Some("shake"));
    if !listed {
        let first = agent
            .with_token_guard_state(|s| !std::mem::replace(&mut s.shake.missing_logged, true))
            .await;
        if first {
            log::info!(
                "token-guard: omp does not list /shake for session {}; post-turn shake skipped",
                agent.session_id()
            );
        }
        return;
    }
    agent.with_token_guard_state(|s| s.shake.begin()).await;
    let result = agent
        .request_rpc_if_idle(
            json!({ "type": "prompt", "message": shake::SHAKE_COMMAND }),
            SHAKE_RPC_TIMEOUT_MS,
            "Shake refused",
        )
        .await;
    let accepted = matches!(
        &result,
        Ok(res) if res.get("success").and_then(Value::as_bool) == Some(true)
    );
    if accepted {
        // The reply frame normally lands before or right after the RPC response; the swallow
        // window closes after a short bound either way so a later command output is never hidden.
        tokio::time::sleep(Duration::from_millis(shake::SHAKE_REPLY_WINDOW_MS)).await;
    }
    agent.with_token_guard_state(|s| s.shake.finish()).await;
    if accepted {
        let _ = agent.refresh_from_state().await;
    }
    log::info!(
        "token-guard: shake for session {} at {:?} context tokens: {}",
        agent.session_id(),
        tokens,
        if accepted { "sent" } else { "skipped" }
    );
}
