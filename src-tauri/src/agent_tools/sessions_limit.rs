// Per sender-and-target rate limit for Session messages (#1858, FR-013). Only delivered sends are
// recorded, so a refused send never uses up the allowance.

use std::collections::{HashMap, VecDeque};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

pub const MAX_SENDS: usize = 10;
pub const WINDOW: Duration = Duration::from_secs(600);

#[derive(Default)]
pub struct SendLimiter {
    sends: Mutex<HashMap<(String, String), VecDeque<Instant>>>,
}

/// One limiter for the app: the pair key already names the sender.
pub static LIMITER: LazyLock<SendLimiter> = LazyLock::new(SendLimiter::default);

impl SendLimiter {
    /// `Err` carries the seconds until the oldest counted send leaves the window.
    pub fn check(&self, from: &str, to: &str, now: Instant) -> Result<(), u64> {
        let mut sends = self.sends.lock().unwrap_or_else(|e| e.into_inner());
        let key = (from.to_string(), to.to_string());
        let Some(times) = sends.get_mut(&key) else {
            return Ok(());
        };
        while times
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) >= WINDOW)
        {
            times.pop_front();
        }
        if times.len() < MAX_SENDS {
            return Ok(());
        }
        let oldest = times.front().copied().unwrap_or(now);
        let wait = WINDOW.saturating_sub(now.saturating_duration_since(oldest));
        Err(wait.as_secs().max(1))
    }

    /// Counts a delivered send.
    pub fn record(&self, from: &str, to: &str, now: Instant) {
        let mut sends = self.sends.lock().unwrap_or_else(|e| e.into_inner());
        // Pairs whose every send has left the window are dropped, so the map cannot grow forever.
        sends.retain(|_, times| {
            times
                .back()
                .is_some_and(|t| now.saturating_duration_since(*t) < WINDOW)
        });
        sends
            .entry((from.to_string(), to.to_string()))
            .or_default()
            .push_back(now);
    }
}

#[cfg(test)]
#[path = "sessions_limit.test.rs"]
mod tests;
