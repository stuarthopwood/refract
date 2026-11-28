// Per-tab scrollback: a fixed-capacity byte ring (FR-010). It never leaves memory and is never persisted.
// Offsets are absolute (bytes since the shell started) so most-recent-command markers can name a position
// that stays meaningful after older bytes are dropped.

use std::collections::VecDeque;

use super::limits::SCROLLBACK_BYTES;

#[derive(Debug)]
pub struct Ring {
    capacity: usize,
    buf: VecDeque<u8>,
    /// Absolute offset of the next byte to be written.
    total_written: u64,
}

impl Ring {
    pub fn new() -> Self {
        Self::with_capacity(SCROLLBACK_BYTES)
    }

    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity,
            buf: VecDeque::new(),
            total_written: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    /// Absolute offset of the next byte to be written.
    pub fn total_written(&self) -> u64 {
        self.total_written
    }

    /// Absolute offset of the oldest retained byte.
    pub fn start(&self) -> u64 {
        self.total_written - self.buf.len() as u64
    }

    /// Appends `data`, dropping the oldest bytes beyond capacity. When the cut lands inside a line, the
    /// oldest retained line is dropped too so a replay never begins mid-line, unless the retained data is a
    /// single line (then its tail is kept as it is).
    pub fn push(&mut self, data: &[u8]) {
        self.total_written += data.len() as u64;
        let mut cut_before: Option<u8> = None;
        if data.len() >= self.capacity {
            // The incoming chunk alone fills the ring: only its tail survives.
            let skipped = data.len() - self.capacity;
            cut_before = if skipped > 0 {
                Some(data[skipped - 1])
            } else {
                self.buf.back().copied()
            };
            self.buf.clear();
            self.buf.extend(&data[skipped..]);
        } else {
            self.buf.extend(data);
            let excess = self.buf.len().saturating_sub(self.capacity);
            if excess > 0 {
                cut_before = self.buf.get(excess - 1).copied();
                self.buf.drain(..excess);
            }
        }
        if let Some(last_dropped) = cut_before {
            if last_dropped != b'\n' {
                self.skip_partial_line();
            }
        }
    }

    // Drops through the first newline, but only when content follows it.
    fn skip_partial_line(&mut self) {
        if let Some(newline) = self.buf.iter().position(|byte| *byte == b'\n') {
            if newline + 1 < self.buf.len() {
                self.buf.drain(..=newline);
            }
        }
    }

    /// Every retained byte, oldest first.
    pub fn snapshot(&self) -> Vec<u8> {
        let (front, back) = self.buf.as_slices();
        let mut out = Vec::with_capacity(self.buf.len());
        out.extend_from_slice(front);
        out.extend_from_slice(back);
        out
    }

    /// The last `n` lines of the retained bytes. A trailing newline ends the last line; it does not start
    /// an empty one.
    pub fn tail_lines(&self, n: usize) -> Vec<u8> {
        if n == 0 || self.buf.is_empty() {
            return Vec::new();
        }
        let mut seen = 0;
        let mut start = 0;
        let last = self.buf.len() - 1;
        for (index, byte) in self.buf.iter().enumerate().rev() {
            if *byte == b'\n' && index != last {
                seen += 1;
                if seen == n {
                    start = index + 1;
                    break;
                }
            }
        }
        self.buf.iter().skip(start).copied().collect()
    }
}

impl Default for Ring {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
#[path = "ring.test.rs"]
mod tests;
