// Advisor chip (issue #937, follow-up to #917/PR #923): the composer status line's own on/off
// indicator for omp's advisor subsystem, session-scoped. Lane extension point (issue #784):
// this file owns its own `State` (held inside `AgentState` via `with_advisor_state`,
// `agent/mod.rs`) and its own `on_launch`/`on_turn_settled`/`on_exit` hooks, called from
// `agent/launch.rs` and `agent/frame.rs` the same way every other lane (`model`, `readout`,
// `side_chat`, `start_queue`, `subagents`, `termination`) already does. `handle_command_output`
// is the ONE thing `agent/frame.rs`'s own `"command_output"` dispatch arm calls directly (not
// through the usual unconditional lane-extension list): it both decides whether to swallow a
// silent probe reply AND updates the chip's own state from an authoritative toggle reply, in
// one pass, so frame.rs never also has to call a separate lane `on_frame` for the same frame
// afterward.
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
// prefix, and `is_known_ambiguous_status_shape` separately recognises (without trusting the
// on/off meaning of) that one documented ambiguous wording so it can still be consumed rather
// than left to render as a stray notice.
//
// Decided (Skippy, delegated by Stuart 2026-10-18, recorded on issue #937): given that
// ambiguity, the attach/resume probe below is a best-effort hint, not a guarantee the chip
// always matches omp's live state immediately after a resume -- a typed or chip-sent
// `/advisor on|off` is still the only fully-trusted signal, matching the issue's own risk note.
//
// Gate round 1: `request_rpc` is a raw RPC passthrough with no classification (unlike
// `ipc::chat::chat_send`'s own `classify_slash_invocation`) -- sending the probe to an omp build
// that does not actually list `advisor` would reach the MODEL as a literal chat prompt, a real
// visible turn. `on_launch`/`maybe_send_probe` check `available_commands()` every attempt (gate
// round 2: the list can still be empty or stale right at launch -- `available_commands_update`
// is asynchronous, and `agent/launch.rs` now clears `state.commands` per life so a PREVIOUS
// life's list is never trusted for this one).
//
// Gate round 2 (High, decided): falsified against the actual code -- `agent/launch.rs` sets
// `state.status = Idle` BEFORE calling `on_launch` (so an immediate idle check there proves
// nothing), and `ipc::sessions_agent.rs`'s own `resume_session_core` sends a real "resume"
// prompt immediately after `launch()`/`start()` return; `SessionAgent::send`'s own `status`
// field does not flip to `Working` until the server's OWN `agent_start` frame arrives, so there
// is a real window where a prompt has already been dispatched but `status` still reads `Idle`.
// Two independent triggers now share one `probe_armed` flag (never a blind one-shot timer):
// - `on_launch`'s own bounded poll (`maybe_send_probe`, retried a few times) covers a plain
//   attach with nothing else sending.
// - `on_turn_settled` (`agent/frame.rs`'s own `"session_settled"`/settled `"prompt_result"`
//   arms) retries on every settled turn -- including the resume path's own "resume" turn, the
//   one moment nothing else can possibly be mid-send on this agent.
// `maybe_send_probe` itself uses `request_rpc_if_idle` (the SAME atomic check-and-send primitive
// `session::model`'s own `set_model`/`cycle_model` already rely on for an equivalent race) to
// close the gap between ITS OWN idle check and the send, matching this codebase's existing
// rigor rather than inventing a stronger (and here, not actually obtainable without a new
// client-side "admission in flight" signal this change does not add) guarantee. A `generation`
// counter invalidates a stale attempt from a superseded life; `cancel_pending_probe` (called
// from `ipc::chat.rs` the moment the USER drives `/advisor` themselves) retires the whole
// mechanism early so a real user-authored reply is never at risk of being swallowed or guessed
// at by a still-pending background probe.

use std::time::Duration;

use serde_json::{json, Value};

use super::agent::SessionAgent;

/// `request_rpc_if_idle`'s own timeout for the silent attach/resume probe, and the bound this
/// module waits for the actual `command_output` FRAME (a separate thing from the RPC response
/// itself) before giving up and un-arming the veto -- short, since a slow or missing reply only
/// means the chip stays hidden a little longer (never a wrong state either way).
const PROBE_TIMEOUT_MS: u64 = 5_000;
/// How long `on_launch`'s own bounded attempt waits between retries, and how many times it
/// tries, before leaving the rest to `on_turn_settled` (a best-effort hint either way: giving up
/// here never clears `probe_armed`, so a later settled turn can still catch it).
const PROBE_RETRY_INTERVAL_MS: u64 = 100;
const PROBE_RETRY_ATTEMPTS: u32 = 20;

#[derive(Default)]
pub(super) struct State {
    advisor_on: bool,
    /// Set right before the silent `/advisor status` probe is actually sent; the next
    /// `command_output` frame that looks like a status reply is consumed (parsed, never shown
    /// as a notice) and this clears -- also cleared by `cancel_pending_probe` and after
    /// `PROBE_TIMEOUT_MS` regardless, so a later real command_output (the user's own
    /// `/advisor on`, for example) is never mistaken for this probe's own reply forever.
    awaiting_silent_probe: bool,
    /// Armed by `on_launch`, consumed by whichever of the two trigger points (`on_launch`'s own
    /// bounded poll, or `on_turn_settled`, retried on every settle) actually CLAIMS the probe
    /// first; cleared early by `cancel_pending_probe` the moment the user drives `/advisor`
    /// themselves.
    probe_armed: bool,
    /// Bumped by `on_launch` and `on_exit`. A probe attempt captures the generation it was
    /// armed under; if that no longer matches by the time it is about to act, a stale task from
    /// a superseded life is abandoned -- it can never send, swallow, or clear anything
    /// belonging to the CURRENT life.
    generation: u64,
    /// Gate round 3 fix (High, decided): bumped by `maybe_send_probe`'s own ATOMIC claim step
    /// (the single `with_advisor_state` call that flips `probe_armed` false and
    /// `awaiting_silent_probe` true together, before any await) and by `cancel_pending_probe`.
    /// A claim's own later rollback-on-failure (not idle, refused, `advisor` not listed) only
    /// restores the flags when BOTH the generation AND this epoch still match what it claimed
    /// under -- so a rollback from an attempt that lost a race (the resume path's own
    /// `session_settled` and a settled `prompt_result` can both fire for the SAME turn) can
    /// never re-arm a probe a DIFFERENT, already-progressed attempt (or a user's own
    /// `/advisor`) has since moved past.
    probe_epoch: u64,
}

/// `/advisor on|off`'s own reply text (typed or chip-sent): the two strings #917's own live
/// verification proved stable, trusted without reservation. A trimmed PREFIX match, not
/// `contains` anywhere in the text -- a `contains` match could fire on unrelated text that
/// merely quotes the phrase (an echoed instruction, a later unrelated notice).
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
/// header); anything else -- including the real, observed `Advisor "<name>" is running.`
/// wording -- stays `None`: unknown, chip hidden, never a guessed state.
fn parse_status_reply(trimmed: &str) -> Option<bool> {
    if trimmed.starts_with("Advisor is enabled") {
        Some(true)
    } else if trimmed.starts_with("Advisor is disabled") {
        Some(false)
    } else {
        None
    }
}

/// The one OTHER wording this module has actually seen a `/advisor status` reply use (#917's
/// own live evidence, `Advisor "default" is running.`) -- recognised so it is still consumed
/// (never left to render as a stray notice) without ever being trusted for an on/off reading
/// (see `parse_status_reply`'s own doc comment). Gate round
/// 3 fix (Low, decided): also requires a single line -- a longer, multi-line reply that merely
/// starts and ends with these same fragments is not this known, short shape and must not be
/// swallowed on that resemblance alone. Gate round 4 fix (Low, decided): rejects an embedded
/// `\r` too, not just `\n` -- a bare CR (a stray CRLF artifact) can make a string look
/// single-line to a `\n`-only check while still not actually being this module's own known,
/// single-line shape. Anything starting "Advisor " that matches NEITHER this nor
/// `parse_status_reply` is wording this module has never seen; it renders normally rather than
/// being guessed at.
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
    // Gate round 4 fix (Low, decided): `trim()` (both ends), not `trim_start()` alone -- the
    // shape checks below include an `ends_with` match (`is_known_ambiguous_status_shape`),
    // which a trailing newline/space the start-only trim left behind could make miss a reply
    // that is otherwise exactly this known shape.
    let trimmed = text.trim();

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
    // Gate round 2 fix (Medium, decided): only a frame RECOGNISABLY shaped like `/advisor
    // status`'s own reply is consumed -- either `parse_status_reply` resolves it, or it matches
    // the one known ambiguous shape. Any other `command_output` arriving while the probe is
    // still pending (a concurrent `/usage show`, the resume prompt's own reply) renders
    // normally; the probe keeps waiting, bounded by its own timeout-clear, never forever.
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

/// Gate round 3 fix (High, decided): the one place that actually sends the probe, shared by
/// both trigger points below. The FIRST step is an ATOMIC claim -- one `with_advisor_state`
/// call that requires `probe_armed` and the matching `generation`, then immediately flips
/// `probe_armed` false and `awaiting_silent_probe` true and records a fresh `probe_epoch` --
/// all BEFORE any `await`. This fixes two races a post-send flip could not: a reply arriving
/// before the RPC call's own acknowledgement would otherwise find `awaiting_silent_probe` still
/// false and render unswallowed, and the resume path's own `session_settled` plus a settled
/// `prompt_result` firing for the SAME turn would otherwise both pass a read-only "is it still
/// armed" check and both try to send. Only ONE caller can ever win the claim (the next one to
/// read the lock sees `probe_armed` already false and backs off immediately, below). Everything
/// after the claim re-checks it needed: `available_commands` (the list can populate between
/// attempts) and `request_rpc_if_idle` (the same atomic check-and-send primitive
/// `session::model`'s own `set_model`/`cycle_model` rely on for an equivalent race). On a
/// refusal or failure, the claim is rolled back -- but ONLY if the generation AND epoch this
/// attempt claimed under still match, so a rollback from an attempt that lost its own race can
/// never re-arm a probe a different, already-progressed attempt (or a user's own `/advisor`,
/// `cancel_pending_probe`) has since moved past. Returns `true` once settled one way or another
/// under this generation (claimed-and-sent, or genuinely nothing left to ever claim -- already
/// resolved by a real reply, or cancelled) so a caller retry-loop can stop; `false` whenever a
/// later retry under the SAME generation might still succeed -- gate round 4 fix (Low,
/// decided): this now ALSO covers losing the claim to another attempt that is still in flight
/// right now (`awaiting_silent_probe` already true) and might yet roll back -- the earlier
/// version returned `true` here too, so `on_launch`'s own bounded retry loop could stop early
/// on a race it only LOOKED settled, and never get another chance if the winning attempt's own
/// `rollback` below ran moments later.
async fn maybe_send_probe(agent: &SessionAgent, expected_generation: u64) -> bool {
    enum ProbeClaim {
        Claimed(u64),
        /// This generation is superseded; genuinely nothing left for this caller to do, ever.
        Stale,
        /// Already resolved (a real reply consumed it) or cancelled by the user's own
        /// `/advisor`; also genuinely nothing left to claim.
        Resolved,
        /// Lost the claim to ANOTHER attempt that is still in flight right now -- it may yet
        /// fail and roll back, so this is NOT settled.
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
        // Gate round 1 fix (High): the RPC response only confirms the prompt was ACCEPTED --
        // the async `command_output` FRAME is a separate thing that might still never arrive (a
        // stale process exit, an odd build). Clear the flag after this timeout regardless,
        // UNLESS a newer life or a later claim has already moved past this one.
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

/// `agent::launch`'s own hook (issue #937's own "on agent attach and after a resume"):
/// `launch()` runs this same code path for every (re)spawn of this Session's own omp process --
/// a brand-new Session, a crash-restart, and a resume alike. Arms the probe and makes a bounded
/// number of attempts (the "plain attach, nothing else sending" case); `on_turn_settled` below
/// is the OTHER trigger (the resume path's own turn settling, or any later turn) -- whichever
/// condition becomes true first claims and sends the probe exactly once. Fire-and-forget: never
/// blocks `launch()`'s own attach sequence.
pub(super) async fn on_launch(agent: &SessionAgent) {
    // Fail-to-unknown BEFORE anything else -- a restart or resume must never keep showing a
    // stale "on" reading left over from the previous process life while the probe (which may be
    // skipped, delayed, or simply never reply) is pending.
    apply_and_emit(agent, false).await;
    let generation = agent
        .with_advisor_state(|s| {
            s.generation = s.generation.wrapping_add(1);
            s.probe_armed = true;
            // Gate round 3 fix (Medium, decided): a superseded PREVIOUS life's own `on_exit`
            // can be skipped entirely (`agent/launch.rs`'s exit fan-out only runs the
            // `is_current`-gated lanes, which this one is, for a life that is still current at
            // exit time -- a life superseded by THIS new one before its own exit is handled
            // never gets that call) -- cleared here too so a stale `true` left over from that
            // skipped `on_exit` can never make a later real reply look like it was already
            // consumed by a probe this life never actually armed yet.
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
        // Exhausted this attach's own bounded attempts without sending -- still armed, left for
        // `on_turn_settled` to retry on whatever turn eventually settles (the resume path's own
        // "resume" turn, most likely, if that is why every attempt above found it not-idle).
    });
}

/// `agent/frame.rs`'s own `"session_settled"`/settled-`"prompt_result"` hook: the one moment
/// nothing else on this agent can possibly be mid-send, so it is always safe to retry here if
/// the probe is still armed. Fire-and-forget, spawned so a (bounded) RPC round trip never
/// blocks the frame-listener loop from processing subsequent frames.
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
