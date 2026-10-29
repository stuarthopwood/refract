// Issue #561: the round-trip time of the quick RPC commands Refract already sends, kept only as
// the latest sample plus a slow streak (no polling, no history). `session::health` reads it
// through `OmpProcess::rpc_latency` and decides whether to surface an "RPC slow" readout.
//
// A child module of `process` so it reaches `Inner` and `OmpProcess::inner` without widening
// their visibility.
use std::sync::Mutex;
use std::time::Duration;

use tokio::time::Instant;

use super::OmpProcess;

/// Quick state or acknowledgement commands only: a command that legitimately runs long
/// (`new_session`, `get_login_providers`, a model switch) would read as a slow agent.
const TRACKED_COMMANDS: &[&str] = &[
    "get_state",
    "get_session_stats",
    "abort",
    "set_thinking_level",
];

/// A sample older than this no longer says anything about the agent's current responsiveness.
const SAMPLE_FRESH_FOR: Duration = Duration::from_secs(60);

/// A sample at or above this counts toward the slow streak (`session::health`'s enter bar).
const SLOW_SAMPLE: Duration = Duration::from_secs(2);

/// The latest tracked round trip, and how many in a row were slow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RpcSample {
    pub latest: Duration,
    pub slow_streak: u32,
}

#[derive(Default)]
pub(super) struct RpcLatency {
    latest: Mutex<Option<(Instant, RpcSample)>>,
}

impl RpcLatency {
    pub(super) fn record(&self, cmd_type: &str, elapsed: Duration) {
        if !TRACKED_COMMANDS.contains(&cmd_type) {
            return;
        }
        let mut guard = self.latest.lock().unwrap();
        let previous_streak = guard.map_or(0, |(_, sample)| sample.slow_streak);
        let slow_streak = if elapsed >= SLOW_SAMPLE {
            previous_streak + 1
        } else {
            0
        };
        *guard = Some((
            Instant::now(),
            RpcSample {
                latest: elapsed,
                slow_streak,
            },
        ));
    }

    fn latest_fresh(&self) -> Option<RpcSample> {
        let (at, sample) = (*self.latest.lock().unwrap())?;
        (at.elapsed() <= SAMPLE_FRESH_FOR).then_some(sample)
    }
}

impl OmpProcess {
    /// The latest tracked command's request-to-response time, or `None` when no sample landed in
    /// the last minute.
    pub fn rpc_latency(&self) -> Option<RpcSample> {
        self.inner.latency.latest_fresh()
    }
}
