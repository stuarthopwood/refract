// Per sender-and-target rate limit for Session messages (#1858, FR-013). A send takes its slot
// before delivery and gives it back if delivery fails, so a refused send never uses the allowance.

use std::collections::{HashMap, VecDeque};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

pub const MAX_SENDS: usize = 10;
pub const WINDOW: Duration = Duration::from_secs(600);

#[derive(Debug, Default)]
pub struct SendLimiter {
    sends: Mutex<HashMap<(String, String), VecDeque<Instant>>>,
}

/// One limiter for the app: the pair key already names the sender.
pub static LIMITER: LazyLock<SendLimiter> = LazyLock::new(SendLimiter::default);

impl SendLimiter {
    /// Checks and counts one send under a single lock, so concurrent sends cannot overshoot the
    /// limit. `Err` carries the seconds until the oldest counted send leaves the window.
    pub fn try_acquire(&self, from: &str, to: &str, now: Instant) -> Result<(), u64> {
        let mut sends = self.sends.lock().unwrap_or_else(|e| e.into_inner());
        // Pairs whose every send has left the window are dropped, so the map cannot grow forever.
        sends.retain(|_, times| {
            times
                .back()
                .is_some_and(|t| now.saturating_duration_since(*t) < WINDOW)
        });
        let times = sends.entry((from.to_string(), to.to_string())).or_default();
        while times
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) >= WINDOW)
        {
            times.pop_front();
        }
        if times.len() >= MAX_SENDS {
            let oldest = times.front().copied().unwrap_or(now);
            let wait = WINDOW.saturating_sub(now.saturating_duration_since(oldest));
            return Err(wait.as_secs().max(1));
        }
        times.push_back(now);
        Ok(())
    }

    /// Gives back the slot `try_acquire` took at `at`, for a send that was not delivered.
    pub fn release(&self, from: &str, to: &str, at: Instant) {
        let mut sends = self.sends.lock().unwrap_or_else(|e| e.into_inner());
        let key = (from.to_string(), to.to_string());
        let Some(times) = sends.get_mut(&key) else {
            return;
        };
        if let Some(index) = times.iter().position(|t| *t == at) {
            times.remove(index);
        }
        if times.is_empty() {
            sends.remove(&key);
        }
    }
}

#[cfg(test)]
#[path = "sessions_limit.test.rs"]
mod tests;
