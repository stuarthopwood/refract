// Input validation for the `terminal.*` channels (FR-024): who may call, how big a name, size or write may
// be, and how fast a tab may be fed. Pure functions; handlers apply them before touching a tab.
// Messages never include terminal content.

use std::time::Instant;

use serde_json::Value;

use super::limits::{
    COLS_MAX, COLS_MIN, INPUT_MAX_BYTES, INPUT_RATE_BYTES_PER_SEC, NAME_MAX_CHARS, ROWS_MAX,
    ROWS_MIN,
};
use crate::ipc::{invalid_argument, IpcError};

/// Every `terminal.*` request may come only from the main window: a shell is arbitrary code execution, so
/// no other webview (a preview, an embedded page) may drive one.
pub fn refuse_caller(channel: &str, window_label: &str) -> Option<Value> {
    if !channel.starts_with("terminal.") || window_label == "main" {
        return None;
    }
    log::warn!("{channel} refused for window {window_label}");
    Some(serde_json::json!({
        "ok": false,
        "error": { "code": "terminal-refused", "message": "The terminal is only available in the main window" }
    }))
}

/// A tab name is trimmed and must then be 1..=40 characters.
pub fn validate_name(raw: &str) -> Result<String, IpcError> {
    let name = raw.trim();
    let chars = name.chars().count();
    if chars == 0 || chars > NAME_MAX_CHARS {
        return Err(invalid_argument(format!(
            "A terminal name must be 1 to {NAME_MAX_CHARS} characters"
        )));
    }
    Ok(name.to_string())
}

/// Sizes are clamped, never rejected: a renderer that measures a transient 0 or an absurd width still gets a
/// working terminal.
pub fn clamp_size(cols: i64, rows: i64) -> (u16, u16) {
    (
        cols.clamp(i64::from(COLS_MIN), i64::from(COLS_MAX)) as u16,
        rows.clamp(i64::from(ROWS_MIN), i64::from(ROWS_MAX)) as u16,
    )
}

/// One `terminal.input` call may carry at most 64 KiB.
pub fn validate_input_size(data: &str) -> Result<(), IpcError> {
    if data.len() > INPUT_MAX_BYTES {
        return Err(invalid_argument(format!(
            "Terminal input is limited to {INPUT_MAX_BYTES} bytes per call"
        )));
    }
    Ok(())
}

/// Per-tab token bucket: `INPUT_RATE_BYTES_PER_SEC` refills continuously and a burst may use the whole
/// bucket, so a paste is accepted but a runaway loop is not. Time is passed in so tests need no sleeping.
#[derive(Debug)]
pub struct RateLimiter {
    tokens: f64,
    last: Instant,
}

impl RateLimiter {
    pub fn new(now: Instant) -> Self {
        Self {
            tokens: INPUT_RATE_BYTES_PER_SEC as f64,
            last: now,
        }
    }

    /// Spends `bytes`, or refuses without spending anything.
    pub fn try_consume(&mut self, bytes: usize, now: Instant) -> Result<(), IpcError> {
        let capacity = INPUT_RATE_BYTES_PER_SEC as f64;
        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();
        self.tokens = (self.tokens + elapsed * capacity).min(capacity);
        self.last = now;
        let needed = bytes as f64;
        if needed > self.tokens {
            return Err(IpcError::new(
                "terminal-rate-limited",
                "Terminal input is arriving too fast; slow down and try again",
            ));
        }
        self.tokens -= needed;
        Ok(())
    }
}

#[cfg(test)]
#[path = "guard.test.rs"]
mod tests;
