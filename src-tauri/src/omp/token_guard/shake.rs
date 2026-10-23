// Post-turn shake decisions (#1212, spec 021 FR-011, FR-012, FR-019). RPC `compact` cannot pick a
// method (research.md section 3), so Refract sends `{"type":"prompt","message":"/shake"}` once a
// turn has fully settled and the Session's context is above the threshold. Pure logic only; the
// Session-bound orchestration lives in `session::token_guard`.

use serde_json::Value;

pub const SHAKE_COMMAND: &str = "/shake";
/// Context size above which a settled turn is followed by a shake (FR-011).
pub const SHAKE_CONTEXT_THRESHOLD: u64 = 60_000;
/// How long the `/shake` reply frame is awaited after the RPC is accepted before the swallow
/// window closes, so a later unrelated `command_output` is never hidden.
pub const SHAKE_REPLY_WINDOW_MS: u64 = 2_000;
/// Upper bound the next user prompt waits for an in-flight shake (FR-012).
pub const SHAKE_PROMPT_WAIT_MS: u64 = 10_000;

#[derive(Default)]
pub struct ShakeState {
    /// A shake is running for this Session: the next prompt waits for it.
    pub in_flight: bool,
    /// The next `command_output` frame is the shake's own reply and is hidden from the transcript.
    pub swallow_output: bool,
    /// Settle id (the agent's turn generation) of the last attempt: one attempt per settle.
    last_settle: Option<u64>,
    /// `/shake` was missing from omp's command list and that was already logged.
    pub missing_logged: bool,
}

impl ShakeState {
    /// Claims the single shake attempt for `settle_id`; `false` when one already ran for this
    /// settle or another is still in flight.
    pub fn claim(&mut self, settle_id: u64) -> bool {
        if self.in_flight || self.last_settle == Some(settle_id) {
            return false;
        }
        self.last_settle = Some(settle_id);
        true
    }

    pub fn begin(&mut self) {
        self.in_flight = true;
        self.swallow_output = true;
    }

    pub fn finish(&mut self) {
        self.in_flight = false;
        self.swallow_output = false;
    }
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
    fn one_attempt_per_settle_and_none_while_in_flight() {
        let mut state = ShakeState::default();
        assert!(state.claim(2));
        assert!(!state.claim(2));
        state.begin();
        assert!(!state.claim(4));
        state.finish();
        assert!(state.claim(4));
        assert!(!state.swallow_output);
    }
}
