// Channel frames, Rust -> renderer (data-model.md "Channel frames"): the first byte is the tag.
// `0x01` carries output bytes, `0x02` carries the shell's exit code as an i32 in little-endian order.

use std::time::{Duration, Instant};

pub const TAG_DATA: u8 = 0x01;
pub const TAG_EXIT: u8 = 0x02;

/// Output is held at most this long before it is sent, so a burst becomes one frame instead of many.
pub const COALESCE_WINDOW: Duration = Duration::from_millis(8);
/// A frame never carries more than this many output bytes.
pub const COALESCE_MAX_BYTES: usize = 64 * 1024;

pub fn encode_data(bytes: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(bytes.len() + 1);
    frame.push(TAG_DATA);
    frame.extend_from_slice(bytes);
    frame
}

pub fn encode_exit(code: i32) -> Vec<u8> {
    let mut frame = Vec::with_capacity(5);
    frame.push(TAG_EXIT);
    frame.extend_from_slice(&code.to_le_bytes());
    frame
}

/// Batches shell output into frames of at most `COALESCE_MAX_BYTES`, each sent no later than
/// `COALESCE_WINDOW` after its first byte arrived. Time is passed in so tests need no sleeping.
#[derive(Debug, Default)]
pub struct Coalescer {
    pending: Vec<u8>,
    first_byte_at: Option<Instant>,
}

impl Coalescer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds output read at `now`. Returns every chunk that is ready to send (possibly none): full
    /// chunks of `COALESCE_MAX_BYTES`, then the remainder if its window has already elapsed.
    pub fn push(&mut self, data: &[u8], now: Instant) -> Vec<Vec<u8>> {
        if self.pending.is_empty() && !data.is_empty() {
            self.first_byte_at = Some(now);
        }
        self.pending.extend_from_slice(data);
        let mut ready = Vec::new();
        while self.pending.len() >= COALESCE_MAX_BYTES {
            let rest = self.pending.split_off(COALESCE_MAX_BYTES);
            ready.push(std::mem::replace(&mut self.pending, rest));
            // Whatever remains started arriving no earlier than this push.
            self.first_byte_at = (!self.pending.is_empty()).then_some(now);
        }
        ready.extend(self.poll(now));
        ready
    }

    /// The held bytes if their window has elapsed at `now`.
    pub fn poll(&mut self, now: Instant) -> Option<Vec<u8>> {
        let started = self.first_byte_at?;
        if now.saturating_duration_since(started) >= COALESCE_WINDOW {
            self.flush()
        } else {
            None
        }
    }

    /// Everything held, regardless of the window (the reader hit end-of-file).
    pub fn flush(&mut self) -> Option<Vec<u8>> {
        self.first_byte_at = None;
        (!self.pending.is_empty()).then(|| std::mem::take(&mut self.pending))
    }

    /// How long until held bytes are due, or `None` when nothing is held.
    pub fn time_until_due(&self, now: Instant) -> Option<Duration> {
        let started = self.first_byte_at?;
        Some(COALESCE_WINDOW.saturating_sub(now.saturating_duration_since(started)))
    }
}

#[cfg(test)]
#[path = "frame.test.rs"]
mod tests;
