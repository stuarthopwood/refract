// Advisor chip state. omp exposes no advisor on/off field, so only the explicit
// `/advisor on|off` replies are trusted; the attach-time status probe is a best-effort hint.

use std::time::Duration;

use serde_json::{json, Value};

use super::agent::SessionAgent;

/// How long the probe waits for its `command_output` frame before un-arming the veto.
const PROBE_TIMEOUT_MS: u64 = 5_000;
/// Retry gap and attempt count for `on_launch`; `on_turn_settled` picks up any leftover probe.
const PROBE_RETRY_INTERVAL_MS: u64 = 100;
const PROBE_RETRY_ATTEMPTS: u32 = 20;

#[derive(Default)]
pub(super) struct State {
    advisor_on: bool,
    /// Set while the silent `/advisor status` probe awaits its reply; cleared on timeout or cancel.
    awaiting_silent_probe: bool,
    /// Armed by `on_launch`; the first trigger to claim it sends the probe.
    probe_armed: bool,
    /// Bumped on each life change; stale probe tasks from an old life abandon themselves.
    generation: u64,
    /// Bumped on each probe claim and cancel; a rollback only applies if the epoch still matches.
    probe_epoch: u64,
}

/// The two `/advisor on|off` replies, trusted as a trimmed prefix match.
fn parse_toggle_reply(trimmed: &str) -> Option<bool> {
    if trimmed.starts_with("Advisor enabled.") {
        Some(true)
    } else if trimmed.starts_with("Advisor disabled.") {
        Some(false)
    } else {
        None
    }
}

/// Parses `/advisor status`; only an unambiguous enabled/disabled prefix counts.
fn parse_status_reply(trimmed: &str) -> Option<bool> {
    if trimmed.starts_with("Advisor is enabled") {
        Some(true)
    } else if trimmed.starts_with("Advisor is disabled") {
        Some(false)
    } else {
        None
    }
}

/// Recognises the one known ambiguous status wording so it is consumed, not shown, without trusting it.
fn is_known_ambiguous_status_shape(trimmed: &str) -> bool {
    trimmed.starts_with("Advisor \"")
        && trimmed.ends_with("is running.")
        && !trimmed.contains('\n')
        && !trimmed.contains('\r')
}

async fn apply_and_emit(agent: &SessionAgent, advisor_on: bool) {
    let changed = agent
        .with_advisor_state(|s| {
            let changed = s.advisor_on != advisor_on;
            s.advisor_on = advisor_on;
            changed
        })
        .await;
    if changed && agent.is_visible() {
        agent
            .events()
            .emit_advisor_update(agent.session_id(), advisor_on);
    }
}

/// Consumes a silent probe reply and updates the chip; `true` means the frame must not render.
pub(super) async fn handle_command_output(agent: &SessionAgent, frame: &Value) -> bool {
    let text = frame
        .get("text")
        .and_then(Value::as_str)
        .or_else(|| frame.get("message").and_then(Value::as_str))
        .unwrap_or("");
    // Trim both ends so a stray trailing newline cannot defeat the shape checks.
    let trimmed = text.trim();

    // Toggle replies always win, even while a probe is pending.
    if let Some(on) = parse_toggle_reply(trimmed) {
        apply_and_emit(agent, on).await;
        return false;
    }

    let awaiting = agent.with_advisor_state(|s| s.awaiting_silent_probe).await;
    if !awaiting {
        return false;
    }
    // Only a frame shaped like the status reply is consumed; anything else renders normally.
    let status = parse_status_reply(trimmed);
    if status.is_none() && !is_known_ambiguous_status_shape(trimmed) {
        return false;
    }
    agent
        .with_advisor_state(|s| {
            s.awaiting_silent_probe = false;
            s.probe_armed = false;
        })
        .await;
    if let Some(on) = status {
        apply_and_emit(agent, on).await;
    }
    true
}

/// Sends the silent probe once: an atomic claim, then a checked send. `true` means settled, stop retrying.
async fn maybe_send_probe(agent: &SessionAgent, expected_generation: u64) -> bool {
    enum ProbeClaim {
        Claimed(u64),
        /// Superseded generation: nothing left for this caller to do.
        Stale,
        /// Already resolved or cancelled: nothing left to claim.
        Resolved,
        /// Another attempt holds the claim; it may still roll back, so not settled.
        LostToConcurrent,
    }
    let claim = agent
        .with_advisor_state(|s| {
            if s.generation != expected_generation {
                return ProbeClaim::Stale;
            }
            if !s.probe_armed {
                return if s.awaiting_silent_probe {
                    ProbeClaim::LostToConcurrent
                } else {
                    ProbeClaim::Resolved
                };
            }
            s.probe_armed = false;
            s.awaiting_silent_probe = true;
            s.probe_epoch = s.probe_epoch.wrapping_add(1);
            ProbeClaim::Claimed(s.probe_epoch)
        })
        .await;
    let epoch = match claim {
        ProbeClaim::Claimed(epoch) => epoch,
        ProbeClaim::Stale | ProbeClaim::Resolved => return true,
        ProbeClaim::LostToConcurrent => return false,
    };

    async fn rollback(agent: &SessionAgent, expected_generation: u64, epoch: u64) {
        agent
            .with_advisor_state(|s| {
                if s.generation == expected_generation && s.probe_epoch == epoch {
                    s.probe_armed = true;
                    s.awaiting_silent_probe = false;
                }
            })
            .await;
    }

    let has_advisor_command = agent
        .available_commands()
        .await
        .iter()
        .any(|c| c.get("name").and_then(Value::as_str) == Some("advisor"));
    if !has_advisor_command {
        rollback(agent, expected_generation, epoch).await;
        return false; // the list may still populate later; keep retrying under this generation.
    }
    let result = agent
        .request_rpc_if_idle(
            json!({ "type": "prompt", "message": "/advisor status" }),
            PROBE_TIMEOUT_MS,
            "Advisor state probe refused",
        )
        .await;
    let succeeded = matches!(
        &result,
        Ok(res) if res.get("success").and_then(Value::as_bool) == Some(true)
    );
    if !succeeded {
        rollback(agent, expected_generation, epoch).await;
        return false; // refused (not idle) or failed -- a later trigger may retry.
    }
    let agent_clone = agent.arc();
    tokio::spawn(async move {
        // The RPC response only confirms acceptance; the timeout un-arms the veto if the frame never comes.
        tokio::time::sleep(Duration::from_millis(PROBE_TIMEOUT_MS)).await;
        agent_clone
            .with_advisor_state(|s| {
                if s.generation == expected_generation && s.probe_epoch == epoch {
                    s.awaiting_silent_probe = false;
                }
            })
            .await;
    });
    true
}

/// Launch hook: arms the probe and makes a bounded number of attempts. Fire-and-forget.
pub(super) async fn on_launch(agent: &SessionAgent) {
    // Fail to unknown first so a stale "on" from the last life never shows while the probe is pending.
    apply_and_emit(agent, false).await;
    let generation = agent
        .with_advisor_state(|s| {
            s.generation = s.generation.wrapping_add(1);
            s.probe_armed = true;
            // Clears any leftover armed state from a superseded life whose exit hook may have been skipped.
            s.awaiting_silent_probe = false;
            s.generation
        })
        .await;

    let agent = agent.arc();
    tokio::spawn(async move {
        for attempt in 0..PROBE_RETRY_ATTEMPTS {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(PROBE_RETRY_INTERVAL_MS)).await;
            }
            if maybe_send_probe(&agent, generation).await {
                return;
            }
        }
        // Still armed; `on_turn_settled` retries on the next settled turn.
    });
}

/// Settled-turn hook: retries the probe if still armed. Spawned so it never blocks the frame loop.
pub(super) async fn on_turn_settled(agent: &SessionAgent) {
    let (armed, generation) = agent
        .with_advisor_state(|s| (s.probe_armed, s.generation))
        .await;
    if !armed {
        return;
    }
    let agent = agent.arc();
    tokio::spawn(async move {
        maybe_send_probe(&agent, generation).await;
    });
}

/// `ipc::chat.rs`'s own hook (gate round 2, decided): the user is already driving `/advisor`
/// themselves -- retires the whole background mechanism early so a real user-authored reply can
/// never be swallowed or raced by a still-pending probe. Never resets `advisor_on` itself: the
/// user's own command reply updates that through the normal `handle_command_output` toggle path
/// a moment later, exactly as if the user had typed it with no probe ever having run. Gate
/// round 3 fix (High, decided): also bumps `probe_epoch` -- an in-flight claim's own
/// rollback-on-failure checks this, so it can never re-arm `probe_armed` after a cancel landed
/// first. If the probe's own reply still arrives after this (the request was already accepted
/// before the cancel), it renders as a plain notice instead of being swallowed -- acceptable,
/// and rare, since `awaiting_silent_probe` is already false by then.
pub async fn cancel_pending_probe(agent: &SessionAgent) {
    agent
        .with_advisor_state(|s| {
            s.probe_armed = false;
            s.awaiting_silent_probe = false;
            s.probe_epoch = s.probe_epoch.wrapping_add(1);
        })
        .await;
}

/// `agent::launch`'s own exit fan-out: the next life's own `on_launch` already fails-to-unknown
/// before it probes, but a process that exits WITHOUT a next life starting right away (a crash
/// with no auto-restart, a deliberate Stop) must not leave a stale "on" chip showing either.
/// Bumps the generation so any still-in-flight task from this life is abandoned quietly.
pub(super) async fn on_exit(agent: &SessionAgent) {
    agent
        .with_advisor_state(|s| {
            s.generation = s.generation.wrapping_add(1);
            s.probe_armed = false;
            s.awaiting_silent_probe = false;
        })
        .await;
    apply_and_emit(agent, false).await;
}

/// `ipc::conversations::build_snapshot`'s own one-line hook (mirrors `readout`'s own
/// `current_readout_value`): the last-known on/off state, so a Session snapshot returns the
/// live reading instead of always starting from `false` until the first event arrives.
pub async fn current_advisor_value(agent: &SessionAgent) -> bool {
    agent.with_advisor_state(|s| s.advisor_on).await
}
