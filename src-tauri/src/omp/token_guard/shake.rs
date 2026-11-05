// Post-turn shake decisions (#1212). RPC `compact` cannot pick a method, so Refract sends
// `{"type":"prompt","message":"/shake"}` once a turn settles above the threshold. Pure logic only.

use serde_json::Value;

pub const SHAKE_COMMAND: &str = "/shake";
/// Context size above which a settled turn is followed by a shake.
pub const SHAKE_CONTEXT_THRESHOLD: u64 = 60_000;
/// How long the `/shake` reply frame is awaited after the RPC is accepted before the swallow
/// window closes, so a later unrelated `command_output` is never hidden.
pub const SHAKE_REPLY_WINDOW_MS: u64 = 2_000;
/// Upper bound the next user prompt waits for an in-flight shake.
pub const SHAKE_PROMPT_WAIT_MS: u64 = 10_000;
/// After a shake, or after omp reports it paused automatic maintenance, the context must grow by
/// this many tokens before another shake is attempted, so one that cannot help does not re-run.
pub const SHAKE_REGROWTH_TOKENS: u64 = 10_000;
/// Text omp's warning carries when compaction cannot create headroom and it stops maintenance.
const MAINTENANCE_PAUSED_MARKER: &str = "pausing automatic maintenance";

#[derive(Default)]
pub struct ShakeState {
    /// A shake attempt is claimed and not yet accepted or abandoned: the next prompt waits for it.
    pub in_flight: bool,
    /// The next shake `command_output` frame is the shake's own reply and is hidden from the
    /// transcript; also holds off new claims, so the shake's own settle never re-triggers one.
    pub swallow_output: bool,
    /// A shake cycle (stats read, send, reply, post-shake bookkeeping) is running; blocks new
    /// claims only, never a user prompt.
    active: bool,
    /// Settle id (the agent's turn generation) of the last attempt: one attempt per settle.
    last_settle: Option<u64>,
    /// Context size recorded after the last shake; `None` until one ran in this Conversation.
    post_shake_tokens: Option<u64>,
    /// The next settle is the Hand off summary turn's and must not trigger a shake.
    suppress_next: bool,
    /// `/shake` was missing from omp's command list and that was already logged.
    pub missing_logged: bool,
}

impl ShakeState {
    /// Claims the single shake attempt for `settle_id` and marks it in flight in the same step;
    /// `false` when one already ran for this settle, another is active, or the settle belongs to
    /// the Hand off summary turn.
    pub fn claim(&mut self, settle_id: u64) -> bool {
        if std::mem::take(&mut self.suppress_next) {
            return false;
        }
        if self.active
            || self.in_flight
            || self.swallow_output
            || self.last_settle == Some(settle_id)
        {
            return false;
        }
        self.last_settle = Some(settle_id);
        self.in_flight = true;
        self.active = true;
        true
    }

    pub fn suppress_next_settle(&mut self, suppress: bool) {
        self.suppress_next = suppress;
    }

    /// Drops a pending Hand off suppression so it can never skip a later, legitimate shake.
    pub fn clear_suppression(&mut self) {
        self.suppress_next = false;
    }

    /// A new Conversation starts without a post-shake baseline.
    pub fn reset_baseline(&mut self) {
        self.post_shake_tokens = None;
    }

    pub fn record_post_shake(&mut self, tokens: u64) {
        self.post_shake_tokens = Some(tokens);
    }

    /// The shared pause: omp stopped automatic maintenance at `tokens`, so no shake is attempted
    /// until the context regrows by the margin.
    pub fn pause_maintenance(&mut self, tokens: u64) {
        self.post_shake_tokens = Some(tokens);
    }

    /// Above the threshold, and (after a previous shake) grown enough since it.
    pub fn needs_shake(&self, tokens: Option<u64>) -> bool {
        exceeds_threshold(tokens)
            && match (tokens, self.post_shake_tokens) {
                (Some(t), Some(post)) => t >= post.saturating_add(SHAKE_REGROWTH_TOKENS),
                _ => true,
            }
    }

    /// Opens the reply window just before the shake RPC is sent, and starts measuring regrowth
    /// from the pre-shake size so a failed post-shake read still leaves a baseline.
    pub fn arm_swallow(&mut self, pre_shake_tokens: Option<u64>) {
        self.swallow_output = true;
        if pre_shake_tokens.is_some() {
            self.post_shake_tokens = pre_shake_tokens;
        }
    }

    /// The shake RPC was answered: stop blocking prompts, keep hiding its reply until it arrives.
    pub fn sent(&mut self) {
        self.in_flight = false;
    }

    pub fn finish(&mut self) {
        self.active = false;
        self.in_flight = false;
        self.swallow_output = false;
    }
}

/// Whether a `command_output` frame is the shake's reply: any frame that names its command must
/// name `shake`; one that names none is taken to be the reply while the window is open.
pub fn is_shake_reply(frame: &Value) -> bool {
    ["command", "commandName", "name"]
        .iter()
        .find_map(|k| frame.get(*k).and_then(Value::as_str))
        .is_none_or(|name| name.trim_start_matches('/') == "shake")
}

/// Whether a `notice` frame is omp saying it paused automatic maintenance.
pub fn is_maintenance_paused_notice(frame: &Value) -> bool {
    frame
        .get("message")
        .and_then(Value::as_str)
        .is_some_and(|m| m.contains(MAINTENANCE_PAUSED_MARKER))
}

/// Fresh context size from a `get_session_stats` response's `data` (never the possibly stale
/// readout).
pub fn context_tokens_from_stats(data: &Value) -> Option<u64> {
    data.get("contextUsage")?.get("tokens")?.as_u64()
}

pub fn exceeds_threshold(tokens: Option<u64>) -> bool {
    tokens.is_some_and(|t| t > SHAKE_CONTEXT_THRESHOLD)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn threshold_is_strictly_above_sixty_thousand() {
        assert!(!exceeds_threshold(None));
        assert!(!exceeds_threshold(Some(60_000)));
        assert!(exceeds_threshold(Some(60_001)));
    }

    #[test]
    fn reads_tokens_from_fresh_stats() {
        let data = json!({ "contextUsage": { "tokens": 75000, "contextWindow": 200000 } });
        assert_eq!(context_tokens_from_stats(&data), Some(75_000));
        assert_eq!(context_tokens_from_stats(&json!({})), None);
    }

    #[test]
    fn one_attempt_per_settle_and_none_while_active() {
        let mut state = ShakeState::default();
        assert!(state.claim(2));
        assert!(!state.claim(4));
        state.arm_swallow(Some(70_000));
        state.sent();
        assert!(!state.claim(4));
        state.finish();
        assert!(state.claim(4));
        state.finish();
        assert!(!state.claim(4));
    }

    #[test]
    fn cycle_stays_active_after_the_reply_until_finish() {
        let mut state = ShakeState::default();
        assert!(state.claim(2));
        state.arm_swallow(Some(70_000));
        state.sent();
        state.swallow_output = false;
        assert!(!state.claim(4));
        assert!(!state.needs_shake(Some(75_000)));
        state.finish();
        assert!(state.claim(4));
    }

    #[test]
    fn suppression_can_be_cleared() {
        let mut state = ShakeState::default();
        state.suppress_next_settle(true);
        state.clear_suppression();
        assert!(state.claim(2));
    }

    #[test]
    fn needs_regrowth_after_a_shake() {
        let mut state = ShakeState::default();
        assert!(state.needs_shake(Some(70_000)));
        state.record_post_shake(65_000);
        assert!(!state.needs_shake(Some(70_000)));
        assert!(state.needs_shake(Some(80_000)));
        state.reset_baseline();
        assert!(state.needs_shake(Some(70_000)));
    }

    #[test]
    fn hand_off_settle_is_suppressed_once() {
        let mut state = ShakeState::default();
        state.suppress_next_settle(true);
        assert!(!state.claim(2));
        assert!(state.claim(4));
    }

    #[test]
    fn reply_matches_by_command_name_when_present() {
        assert!(is_shake_reply(&json!({ "text": "x" })));
        assert!(is_shake_reply(&json!({ "command": "/shake" })));
        assert!(!is_shake_reply(&json!({ "command": "usage" })));
    }
}
