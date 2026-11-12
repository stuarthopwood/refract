// Post-turn shake and per-Conversation model-call counter. Pure decisions live in `omp::token_guard`.
// The shake goes through `request_rpc_if_idle`, so it never runs during an active turn.

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

impl State {
    /// Applies omp's maintenance pause only if no Conversation reset landed since `generation`
    /// was read, so a reset that races the pause wins.
    fn pause_if_current(&mut self, generation: u64) {
        if self.counter.conversation == generation {
            self.shake.set_paused();
        }
    }
}

async fn emit_calls(agent: &SessionAgent) {
    let (conversation, calls) = agent
        .with_token_guard_state(|s| (s.counter.conversation, s.counter.calls))
        .await;
    agent
        .events()
        .emit_token_guard_calls(agent.session_id(), &format!("c{conversation}"), calls);
}

/// `agent/frame.rs` lane hook: counts one call per completed assistant message, and pauses the
/// shake when omp reports it paused automatic maintenance.
pub(super) async fn on_frame(agent: &SessionAgent, frame_type: &str, frame: &Value) {
    if frame_type == "notice" && shake::is_maintenance_paused_notice(frame) {
        let generation = agent
            .with_token_guard_state(|s| s.counter.conversation)
            .await;
        // Spawned: the pause must not hold up the loop that delivers this frame.
        let agent = agent.arc();
        tokio::spawn(async move {
            agent
                .with_token_guard_state(|s| s.pause_if_current(generation))
                .await;
        });
        return;
    }
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
        .with_token_guard_state(|s| {
            s.counter.reset(calls);
            s.shake.reset_baseline();
            s.shake.clear_suppression();
        })
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

/// Starts capturing the Hand off summary; its own settle must not trigger a shake.
pub(super) async fn begin_summary_capture(agent: &SessionAgent) {
    agent
        .with_token_guard_state(|s| {
            s.counter.begin_capture();
            s.shake.suppress_next_settle(true);
        })
        .await;
}

/// `settled_ok` false means no summary settle will arrive, so the suppression is dropped.
pub(super) async fn end_summary_capture(agent: &SessionAgent, settled_ok: bool) -> Option<String> {
    agent
        .with_token_guard_state(|s| {
            if !settled_ok {
                s.shake.suppress_next_settle(false);
            }
            s.counter.end_capture()
        })
        .await
}

/// The Hand off failed after its summary settled: a leftover suppression must not outlive it.
pub(super) async fn clear_summary_suppression(agent: &SessionAgent) {
    agent
        .with_token_guard_state(|s| s.shake.clear_suppression())
        .await;
}

/// `agent/frame.rs`'s `command_output` arm: `true` when this frame is the shake's own reply.
pub(super) async fn swallow_shake_output(agent: &SessionAgent, frame: &Value) -> bool {
    if !shake::is_shake_reply(frame) {
        return false;
    }
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
/// The claim also marks the shake in flight, so a prompt arriving before the stats read waits.
pub(super) async fn on_turn_settled(agent: &SessionAgent, settle_id: u64) {
    let claimed = agent
        .with_token_guard_state(|s| s.shake.claim(settle_id))
        .await;
    if !claimed {
        return;
    }
    let agent = agent.arc();
    tokio::spawn(async move {
        run_shake(&agent).await;
        agent.with_token_guard_state(|s| s.shake.finish()).await;
    });
}

async fn context_tokens(agent: &SessionAgent) -> Option<u64> {
    let stats = agent
        .request_rpc(json!({ "type": "get_session_stats" }), STATS_TIMEOUT_MS)
        .await;
    stats
        .ok()
        .filter(|res| res.get("success").and_then(Value::as_bool) == Some(true))
        .and_then(|res| res.get("data").and_then(shake::context_tokens_from_stats))
}

/// Runs one claimed attempt; the caller releases the cycle (in-flight, swallow, active) afterwards.
async fn run_shake(agent: &SessionAgent) {
    let tokens = context_tokens(agent).await;
    if !agent
        .with_token_guard_state(|s| s.shake.needs_shake(tokens))
        .await
    {
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
            log::info!("token-guard: omp does not list /shake; post-turn shake skipped");
        }
        return;
    }
    // The reply window opens before the send so a fast `command_output` is never missed.
    agent
        .with_token_guard_state(|s| s.shake.arm_swallow(tokens))
        .await;
    let result = agent
        .request_rpc_if_idle(
            json!({ "type": "prompt", "message": shake::SHAKE_COMMAND }),
            SHAKE_RPC_TIMEOUT_MS,
            "Shake refused",
        )
        .await;
    agent.with_token_guard_state(|s| s.shake.sent()).await;
    let accepted = matches!(
        &result,
        Ok(res) if res.get("success").and_then(Value::as_bool) == Some(true)
    );
    if accepted {
        // Hold the swallow window until the reply arrives (the swallow closes it), capped.
        let deadline =
            tokio::time::Instant::now() + Duration::from_millis(shake::SHAKE_REPLY_WINDOW_MS);
        while agent
            .with_token_guard_state(|s| s.shake.swallow_output)
            .await
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(WAIT_POLL_MS)).await;
        }
    }
    if accepted {
        let _ = agent.refresh_from_state().await;
        let after = context_tokens(agent).await.or(tokens);
        if let Some(after) = after {
            agent
                .with_token_guard_state(|s| s.shake.record_post_shake(after))
                .await;
        }
    }
    log::info!(
        "token-guard: post-turn shake {}",
        if accepted { "sent" } else { "skipped" }
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pause_applies_within_the_same_conversation() {
        let mut state = State::default();
        let generation = state.counter.conversation;
        state.pause_if_current(generation);
        assert!(!state.shake.needs_shake(Some(70_000)));
    }

    #[test]
    fn pause_from_before_a_reset_is_dropped() {
        let mut state = State::default();
        let stale = state.counter.conversation;
        state.counter.reset(0);
        state.shake.reset_baseline();
        state.pause_if_current(stale);
        assert!(state.shake.needs_shake(Some(70_000)));
    }
}
