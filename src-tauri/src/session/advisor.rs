// Advisor chip (issue #937, follow-up to #917/PR #923): the composer status line's own on/off
// indicator for omp's advisor subsystem, session-scoped. Lane extension point (issue #784):
// this file owns its own `State` (held inside `AgentState` via `with_advisor_state`,
// `agent/mod.rs`) and its own `on_frame`/`on_launch` hooks, called from `agent/frame.rs` and
// `agent/launch.rs` the same way every other lane (`model`, `readout`, `side_chat`,
// `start_queue`, `subagents`, `termination`) already does -- no other file ever changes shape
// for this lane's sake, except `agent/frame.rs`'s own `"command_output"` dispatch arm, which
// needs one extra conditional (see `consume_if_silent_probe`'s own doc comment for why a lane
// `on_frame` call, which only runs AFTER `apply_transcript_frame` already ran, cannot do this
// by itself).
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
// substring and treats anything else (including that exact "is running." wording) as unknown.
//
// Decided (Skippy, delegated by Stuart 2026-10-18, recorded on issue #937): given that
// ambiguity, the attach/resume probe below is a best-effort hint, not a guarantee the chip
// always matches omp's live state immediately after a resume -- a typed or chip-sent
// `/advisor on|off` is still the only fully-trusted signal, matching the issue's own risk note.

use serde_json::{json, Value};

use super::agent::SessionAgent;

/// `request_rpc`'s own timeout for the silent attach/resume probe; short, since a slow reply
/// only means the chip stays hidden a little longer (never a wrong state either way).
const PROBE_TIMEOUT_MS: u64 = 5_000;

#[derive(Default)]
pub(super) struct State {
    advisor_on: bool,
    /// Set right before the silent `/advisor status` probe is sent (`on_launch`); the next
    /// `command_output` frame is consumed by `consume_if_silent_probe` (parsed, never shown as
    /// a notice) and this clears, whether or not that frame turns out to parse -- see this
    /// file's own header for why one flag is safe here (nothing else talks to this Session's
    /// own omp process between `launch()` and the first real user action).
    awaiting_silent_probe: bool,
}

/// `/advisor on|off`'s own reply text (typed or chip-sent): the two strings #917's own live
/// verification proved stable, trusted without reservation.
fn parse_toggle_reply(text: &str) -> Option<bool> {
    if text.contains("Advisor enabled.") {
        Some(true)
    } else if text.contains("Advisor disabled.") {
        Some(false)
    } else {
        None
    }
}

/// `/advisor status`'s own reply text, used only by the silent attach/resume probe: only an
/// unambiguous "Advisor is enabled"/"Advisor is disabled" substring is trusted (see this file's
/// own header); anything else -- including the real, observed "Advisor \"<name>\" is running."
/// wording -- stays `None`: unknown, chip hidden, never a guessed state.
fn parse_status_reply(text: &str) -> Option<bool> {
    if text.contains("Advisor is enabled") {
        Some(true)
    } else if text.contains("Advisor is disabled") {
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

/// `agent/frame.rs`'s own lane-extension point, called for every decoded frame after its core
/// dispatch has already run (`apply_transcript_frame` already rendered a non-silent
/// `command_output` as a notice by this point -- this only updates the chip's own state on top,
/// for the two authoritative toggle replies). A typed `/advisor status`'s own reply is NOT
/// parsed here (only `parse_toggle_reply`, never `parse_status_reply`): a user explicitly
/// typing `/advisor status` sees its own answer in the transcript as a plain notice, same as
/// before #937, and is never used to silently move the chip from under them.
pub(super) async fn on_frame(agent: &SessionAgent, frame_type: &str, frame: &Value) {
    if frame_type != "command_output" {
        return;
    }
    let text = frame
        .get("text")
        .and_then(Value::as_str)
        .or_else(|| frame.get("message").and_then(Value::as_str))
        .unwrap_or("");
    if let Some(on) = parse_toggle_reply(text) {
        apply_and_emit(agent, on).await;
    }
}

/// `agent/frame.rs`'s own pre-dispatch veto for a silent probe (issue #937's own accessibility
/// note: a hidden `/advisor status` "must not appear in the transcript"). A lane's ordinary
/// `on_frame` above runs AFTER `frame.rs`'s own `apply_transcript_frame` call, too late to stop
/// a frame from being rendered -- so `frame.rs` calls this FIRST, for `command_output` only,
/// and skips `apply_transcript_frame` when it returns `true`. Consumes (never shows) the very
/// next `command_output` while `awaiting_silent_probe` is set, regardless of whether it parses.
pub(super) async fn consume_if_silent_probe(agent: &SessionAgent, frame: &Value) -> bool {
    let was_awaiting = agent
        .with_advisor_state(|s| std::mem::take(&mut s.awaiting_silent_probe))
        .await;
    if !was_awaiting {
        return false;
    }
    let text = frame
        .get("text")
        .and_then(Value::as_str)
        .or_else(|| frame.get("message").and_then(Value::as_str))
        .unwrap_or("");
    if let Some(on) = parse_status_reply(text) {
        apply_and_emit(agent, on).await;
    }
    true
}

/// `agent::launch`'s own hook (issue #937's own "on agent attach and after a resume"):
/// `launch()` runs this same code path for every (re)spawn of this Session's own omp process --
/// a brand-new Session, a crash-restart, and a resume alike -- so this one hook covers both
/// cases the issue names. Fire-and-forget: never blocks `launch()`'s own attach sequence, and a
/// failed or slow probe just leaves the chip hidden (unknown), the safe default.
pub(super) async fn on_launch(agent: &SessionAgent) {
    agent
        .with_advisor_state(|s| s.awaiting_silent_probe = true)
        .await;
    let agent = agent.arc();
    tokio::spawn(async move {
        let result = agent
            .request_rpc(
                json!({ "type": "prompt", "message": "/advisor status" }),
                PROBE_TIMEOUT_MS,
            )
            .await;
        if result.is_err() {
            // No reply is coming for this attempt -- clear the flag so a LATER real
            // `command_output` (the user's own `/advisor on`, for example) is never mistaken
            // for this probe's own reply and swallowed.
            agent
                .with_advisor_state(|s| s.awaiting_silent_probe = false)
                .await;
        }
    });
}

/// `ipc::conversations::build_snapshot`'s own one-line hook (mirrors `readout`'s own
/// `current_readout_value`): the last-known on/off state, so a Session snapshot returns the
/// live reading instead of always starting from `false` until the first event arrives.
pub async fn current_advisor_value(agent: &SessionAgent) -> bool {
    agent.with_advisor_state(|s| s.advisor_on).await
}
