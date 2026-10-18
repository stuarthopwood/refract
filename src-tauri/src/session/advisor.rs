// Advisor chip (issue #937, follow-up to #917/PR #923): the composer status line's own on/off
// indicator for omp's advisor subsystem, session-scoped. Lane extension point (issue #784):
// this file owns its own `State` (held inside `AgentState` via `with_advisor_state`,
// `agent/mod.rs`) and its own `on_launch` hook, called from `agent/launch.rs` the same way
// every other lane (`model`, `readout`, `side_chat`, `start_queue`, `subagents`,
// `termination`) already does. `handle_command_output` is the ONE thing `agent/frame.rs`'s own
// `"command_output"` dispatch arm calls directly (not through the usual unconditional lane-
// extension list): it both decides whether to swallow a silent probe reply AND updates the
// chip's own state from an authoritative toggle reply, in one pass, so frame.rs never also has
// to call a separate lane `on_frame` for the same frame afterward (gate round 1 fix: the
// earlier two-function split risked on_frame re-parsing a frame `consume_if_silent_probe`
// had already decided about).
//
// State source ([INFERENCE], resolved without a live probe -- no build is allowed until the
// build slot is granted, so this reads `omp://rpc.md`'s own documented event-stream schema and
// payload docs only, never a live run): no `get_state` field and no dedicated event carry the
// advisor's on/off boolean. `advisor_cost_changed`/`advisor_yielded` (`omp://rpc.md`'s own
// "Event Stream Schema") carry cost/yield data, not an enabled/disabled flag -- #917's own
// decision record already chose not to read `advisor_cost_changed` for exactly this reason
// ("stays unread"). The only two signals this module trusts without reservation are
// `/advisor on`'s own reply ("Advisor enabled.") and `/advisor off`'s own reply ("Advisor
// disabled."), both proven stable by #917's live verification
// (`scripts/verify-917-advisor-command.mjs`). `/advisor status`'s own reply is NOT trusted the
// same way: #917's own symmetric-evidence thread recorded a real run where `/advisor status`
// replied `Advisor "default" is running.` immediately after an explicit `/advisor off`, and
// left standing, unresolved, that this exact wording might mean "the named advisor object
// stays instantiated" rather than "the review cadence is on" -- the issue's own risk note is
// "pin the patterns and fail to 'unknown' (chip hidden), never to a wrong state", so
// `parse_status_reply` only trusts an unambiguous "Advisor is enabled"/"Advisor is disabled"
// prefix and treats anything else (including that exact "is running." wording) as unknown.
//
// Decided (Skippy, delegated by Stuart 2026-10-18, recorded on issue #937): given that
// ambiguity, the attach/resume probe below is a best-effort hint, not a guarantee the chip
// always matches omp's live state immediately after a resume -- a typed or chip-sent
// `/advisor on|off` is still the only fully-trusted signal, matching the issue's own risk note.
//
// Gate round 1 (High): `request_rpc` is a raw RPC passthrough with no classification (unlike
// `ipc::chat::chat_send`'s own `classify_slash_invocation`) -- sending the probe to an omp build
// that does not actually list `advisor` would reach the MODEL as a literal chat prompt, a real
// visible turn. `on_launch` now checks `available_commands()` first. It also now waits for the
// Session to be genuinely idle before sending: `ipc::sessions_agent.rs`'s own `sessions.resume`
// sends a real "resume" prompt immediately after `launch()` returns, racing this probe on the
// same omp process's stdin if sent unconditionally.

use std::time::Duration;

use serde_json::{json, Value};

use super::agent::{SessionAgent, SessionStatus};

/// `request_rpc`'s own timeout for the silent attach/resume probe, and the bound this module
/// waits for the actual `command_output` FRAME (a separate thing from the RPC response itself)
/// before giving up and un-arming the veto -- short, since a slow or missing reply only means
/// the chip stays hidden a little longer (never a wrong state either way).
const PROBE_TIMEOUT_MS: u64 = 5_000;
/// Gate round 1 (Medium, decided): how long `on_launch` waits for the Session to be idle before
/// sending the probe (`ipc::sessions_agent.rs`'s own resume path sends a real prompt right after
/// `launch()` returns) -- bounded, polled, and a best-effort hint either way: giving up silently
/// after this many attempts just leaves the chip at its safe default (hidden).
const PROBE_IDLE_POLL_INTERVAL_MS: u64 = 100;
const PROBE_IDLE_POLL_ATTEMPTS: u32 = 20;

#[derive(Default)]
pub(super) struct State {
    advisor_on: bool,
    /// Set right before the silent `/advisor status` probe is actually sent (`on_launch`); the
    /// next `command_output` frame that looks like a status reply is consumed (parsed, never
    /// shown as a notice) and this clears -- also cleared on a failed/refused send and after
    /// `PROBE_TIMEOUT_MS` regardless, so a later real command_output (the user's own
    /// `/advisor on`, for example) is never mistaken for this probe's own reply forever.
    awaiting_silent_probe: bool,
}

/// `/advisor on|off`'s own reply text (typed or chip-sent): the two strings #917's own live
/// verification proved stable, trusted without reservation. Gate round 1 fix (Medium): a
/// trimmed PREFIX match, not `contains` anywhere in the text -- a `contains` match could fire on
/// unrelated text that merely quotes the phrase (an echoed instruction, a later unrelated
/// notice).
fn parse_toggle_reply(trimmed: &str) -> Option<bool> {
    if trimmed.starts_with("Advisor enabled.") {
        Some(true)
    } else if trimmed.starts_with("Advisor disabled.") {
        Some(false)
    } else {
        None
    }
}

/// `/advisor status`'s own reply text, used only by the silent attach/resume probe: only an
/// unambiguous "Advisor is enabled"/"Advisor is disabled" PREFIX is trusted (see this file's own
/// header; gate round 1 fix, Medium: a trimmed prefix match, not `contains`, same reasoning as
/// `parse_toggle_reply` above); anything else -- including the real, observed `Advisor "<name>"
/// is running.` wording -- stays `None`: unknown, chip hidden, never a guessed state.
fn parse_status_reply(trimmed: &str) -> Option<bool> {
    if trimmed.starts_with("Advisor is enabled") {
        Some(true)
    } else if trimmed.starts_with("Advisor is disabled") {
        Some(false)
    } else {
        None
    }
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

/// `agent/frame.rs`'s own dispatch arm calls this FIRST, for `command_output` only, BEFORE its
/// own `apply_transcript_frame` -- the one extension point that can stop a frame from ever
/// reaching the transcript at all (a lane's ordinary `on_frame` hook, called straight after
/// `apply_transcript_frame`, is already too late for that). Returns `true` when the frame was
/// fully handled here and must NOT also go through `apply_transcript_frame` (the silent probe's
/// own reply, consumed); `false` otherwise, meaning the caller renders it exactly as before
/// #937 -- covering a typed or chip-sent `/advisor on|off` (still updated here, on the way to
/// `false`, so the chip's own state tracks it too) and every unrelated `command_output`
/// (`/usage show`, `/session info`, the resume prompt's own reply, ...).
pub(super) async fn handle_command_output(agent: &SessionAgent, frame: &Value) -> bool {
    let text = frame
        .get("text")
        .and_then(Value::as_str)
        .or_else(|| frame.get("message").and_then(Value::as_str))
        .unwrap_or("");
    let trimmed = text.trim_start();

    // The two authoritative toggle replies always win, and are never swallowed, even while a
    // probe is still pending (a chip click or a typed `/advisor on|off` racing the probe).
    if let Some(on) = parse_toggle_reply(trimmed) {
        apply_and_emit(agent, on).await;
        return false;
    }

    let awaiting = agent.with_advisor_state(|s| s.awaiting_silent_probe).await;
    if !awaiting {
        return false;
    }
    // Gate round 1 fix (High): only a frame that actually LOOKS like `/advisor status`'s own
    // reply is consumed -- any other command_output arriving while the probe is still pending
    // (a concurrent `/usage show`, the resume prompt's own reply) renders normally; the probe
    // keeps waiting, bounded by `on_launch`'s own timeout-clear below, never forever.
    if !trimmed.starts_with("Advisor ") {
        return false;
    }
    agent
        .with_advisor_state(|s| s.awaiting_silent_probe = false)
        .await;
    if let Some(on) = parse_status_reply(trimmed) {
        apply_and_emit(agent, on).await;
    }
    true
}

/// `agent::launch`'s own hook (issue #937's own "on agent attach and after a resume"):
/// `launch()` runs this same code path for every (re)spawn of this Session's own omp process --
/// a brand-new Session, a crash-restart, and a resume alike -- so this one hook covers both
/// cases the issue names. Fire-and-forget: never blocks `launch()`'s own attach sequence.
pub(super) async fn on_launch(agent: &SessionAgent) {
    // Gate round 1 fix (High, decided): fail-to-unknown BEFORE anything else -- a restart or
    // resume must never keep showing a stale "on" reading left over from the previous process
    // life while the probe (which may be skipped, delayed, or simply never reply) is pending.
    apply_and_emit(agent, false).await;

    let agent = agent.arc();
    tokio::spawn(async move {
        // Gate round 1 fix (High, decided): an omp build that does not list `advisor` at all
        // would otherwise receive this literal text as a normal, visible chat prompt -- see
        // this file's own header. Skip entirely; the chip just stays hidden until a later
        // `/advisor on|off` reply confirms state some other way.
        let has_advisor_command = agent
            .available_commands()
            .await
            .iter()
            .any(|c| c.get("name").and_then(Value::as_str) == Some("advisor"));
        if !has_advisor_command {
            return;
        }

        // Gate round 1 fix (Medium, decided): `ipc::sessions_agent.rs`'s own `sessions.resume`
        // sends a real "resume" prompt immediately after `launch()` returns, racing this probe
        // on the same omp process's stdin. Wait for the Session to actually be idle first,
        // bounded -- give up silently (the safe default) rather than wait forever for a Session
        // that never settles.
        let mut idle = agent.status().await == SessionStatus::Idle;
        let mut attempts = 0;
        while !idle && attempts < PROBE_IDLE_POLL_ATTEMPTS {
            tokio::time::sleep(Duration::from_millis(PROBE_IDLE_POLL_INTERVAL_MS)).await;
            idle = agent.status().await == SessionStatus::Idle;
            attempts += 1;
        }
        if !idle {
            return;
        }

        agent
            .with_advisor_state(|s| s.awaiting_silent_probe = true)
            .await;
        let result = agent
            .request_rpc(
                json!({ "type": "prompt", "message": "/advisor status" }),
                PROBE_TIMEOUT_MS,
            )
            .await;
        // Gate round 1 fix (High): cleared on an `Err` (the request itself failed) AND on an
        // `Ok` response that itself reports `success: false` -- either way, no `command_output`
        // frame is coming for this attempt.
        let succeeded = matches!(
            &result,
            Ok(res) if res.get("success").and_then(Value::as_bool) == Some(true)
        );
        if !succeeded {
            agent
                .with_advisor_state(|s| s.awaiting_silent_probe = false)
                .await;
            return;
        }
        // Gate round 1 fix (High): the RPC response only confirms the prompt was ACCEPTED --
        // the async `command_output` FRAME is a separate thing that might still never arrive (a
        // stale process exit, an odd build). Clear the flag after the same timeout regardless.
        tokio::time::sleep(Duration::from_millis(PROBE_TIMEOUT_MS)).await;
        agent
            .with_advisor_state(|s| s.awaiting_silent_probe = false)
            .await;
    });
}

/// `agent::launch`'s own exit fan-out (gate round 1 fix, decided: "reset on exit too"): the
/// next life's own `on_launch` already fails-to-unknown before it probes, but a process that
/// exits WITHOUT a next life starting right away (a crash with no auto-restart, a deliberate
/// Stop) must not leave a stale "on" chip showing either. Also un-arms any still-pending silent
/// probe, since no reply is ever coming from a process that is already gone.
pub(super) async fn on_exit(agent: &SessionAgent) {
    agent
        .with_advisor_state(|s| s.awaiting_silent_probe = false)
        .await;
    apply_and_emit(agent, false).await;
}

/// `ipc::conversations::build_snapshot`'s own one-line hook (mirrors `readout`'s own
/// `current_readout_value`): the last-known on/off state, so a Session snapshot returns the
/// live reading instead of always starting from `false` until the first event arrives.
pub async fn current_advisor_value(agent: &SessionAgent) -> bool {
    agent.with_advisor_state(|s| s.advisor_on).await
}
