// One tab's output path: the scrollback ring, the coalescer, the attached sink and the ack back-pressure.
// All of it sits behind one lock so "replay the ring, then stream live" can never repeat or skip a byte:
// a byte is either in the ring snapshot an attach replays or arrives after the sink is installed.
// Bytes are never logged here.

use std::io::{ErrorKind, Read};
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use super::frame::{encode_data, encode_exit, Coalescer, COALESCE_MAX_BYTES};
use super::limits::UNACKED_PAUSE_BYTES;
use super::markers::{extract_recent_command, MarkerScanner};
use super::ring::Ring;

/// The reader asks the pty for at most this much per call.
pub const READ_BLOCK_BYTES: usize = 16 * 1024;
/// Resets colour and style, so a ring cut in the middle of an attribute run cannot tint the replay.
const RESET_ATTRIBUTES: &[u8] = b"\x1b[0m";
/// ConPTY asks the host terminal where the cursor is and holds the shell until it hears back.
const CURSOR_QUERY: [u8; 4] = *b"\x1b[6n";
/// The answer Rust gives for a tab nobody is attached to (xterm answers for an attached one).
pub const CURSOR_REPLY: &[u8] = b"\x1b[1;1R";

/// Where frames go: the renderer's channel in the app, a recorder in tests.
pub trait FrameSink: Send {
    /// `false` means the receiver is gone; the stream drops the sink.
    fn send(&mut self, frame: Vec<u8>) -> bool;
}

/// Finds `ESC [ 6 n` across read boundaries. The pattern has no repeated prefix, so one counter suffices.
#[derive(Debug, Default)]
struct QueryScanner {
    matched: usize,
}

impl QueryScanner {
    fn count(&mut self, data: &[u8]) -> usize {
        let mut found = 0;
        for &byte in data {
            if byte == CURSOR_QUERY[self.matched] {
                self.matched += 1;
                if self.matched == CURSOR_QUERY.len() {
                    found += 1;
                    self.matched = 0;
                }
            } else {
                self.matched = usize::from(byte == CURSOR_QUERY[0]);
            }
        }
        found
    }
}

/// Replaying a held query into xterm would make xterm answer it again, and that answer would be typed
/// into the shell.
fn strip_cursor_queries(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index..].starts_with(&CURSOR_QUERY) {
            index += CURSOR_QUERY.len();
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    out
}

struct Inner {
    ring: Ring,
    coalescer: Coalescer,
    scanner: QueryScanner,
    /// Where each prompt began, as absolute offsets into the same stream the ring counts.
    markers: MarkerScanner,
    sink: Option<Box<dyn FrameSink>>,
    /// Payload bytes sent to the sink and not yet acknowledged.
    unacked: usize,
    exit_code: Option<i32>,
    /// The reader will read no more.
    finished: bool,
    /// Back-pressure is off: the shell is going away and its output must drain.
    draining: bool,
}

impl Inner {
    fn deliver(&mut self, frame: Vec<u8>) -> bool {
        let Some(sink) = self.sink.as_mut() else {
            return false;
        };
        if sink.send(frame) {
            return true;
        }
        self.drop_sink();
        false
    }

    fn drop_sink(&mut self) {
        self.sink = None;
        self.unacked = 0;
        self.coalescer.flush();
    }

    fn send_data(&mut self, bytes: &[u8]) -> bool {
        self.deliver(encode_data(bytes))
    }
}

pub struct Stream {
    inner: Mutex<Inner>,
    changed: Condvar,
}

impl Stream {
    pub fn new() -> Self {
        Self::with_ring(Ring::new())
    }

    pub fn with_ring(ring: Ring) -> Self {
        Self {
            inner: Mutex::new(Inner {
                ring,
                coalescer: Coalescer::new(),
                scanner: QueryScanner::default(),
                markers: MarkerScanner::new(),
                sink: None,
                unacked: 0,
                exit_code: None,
                finished: false,
                draining: false,
            }),
            changed: Condvar::new(),
        }
    }

    // A panic in another thread must not take the terminal down with it.
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Records `data` in the ring and, while a sink is attached, queues it for the renderer. Returns how
    /// many cursor-position queries arrived with nobody attached to answer them.
    pub fn ingest(&self, data: &[u8], now: Instant) -> usize {
        let mut inner = self.lock();
        let first_offset = inner.ring.total_written();
        inner.ring.push(data);
        inner.markers.feed(data, first_offset);
        let start = inner.ring.start();
        inner.markers.drop_before(start);
        let queries = inner.scanner.count(data);
        if inner.sink.is_none() {
            return queries;
        }
        inner.unacked += data.len();
        for chunk in inner.coalescer.push(data, now) {
            if !inner.send_data(&chunk) {
                break;
            }
        }
        let unanswered = if inner.sink.is_none() { queries } else { 0 };
        drop(inner);
        // Wakes the flusher, which sleeps until the held bytes are due.
        self.changed.notify_all();
        unanswered
    }

    /// Makes `sink` the one receiver: replays the ring (led by a style reset, without held cursor
    /// queries), then the exit frame if the shell already ended; live output follows through `ingest`.
    /// Any earlier sink is dropped. The acked count restarts, so a late ack from the old receiver is
    /// the only way to undercount, and an undercount only lets the reader run slightly ahead.
    pub fn attach(&self, sink: Box<dyn FrameSink>) {
        let mut inner = self.lock();
        // Held bytes are already in the ring; the replay carries them.
        inner.coalescer.flush();
        inner.sink = Some(sink);
        inner.unacked = 0;
        let mut replay = RESET_ATTRIBUTES.to_vec();
        replay.extend_from_slice(&strip_cursor_queries(&inner.ring.snapshot()));
        for chunk in replay.chunks(COALESCE_MAX_BYTES) {
            inner.unacked += chunk.len();
            if !inner.send_data(chunk) {
                break;
            }
        }
        if let Some(code) = inner.exit_code {
            inner.deliver(encode_exit(code));
        }
        drop(inner);
        self.changed.notify_all();
    }

    pub fn detach(&self) {
        self.lock().drop_sink();
        self.changed.notify_all();
    }

    pub fn is_attached(&self) -> bool {
        self.lock().sink.is_some()
    }

    /// The renderer wrote `bytes` into xterm.
    pub fn ack(&self, bytes: usize) {
        let mut inner = self.lock();
        inner.unacked = inner.unacked.saturating_sub(bytes);
        drop(inner);
        self.changed.notify_all();
    }

    /// Blocks while an attached receiver is too far behind. A detached tab never waits.
    pub fn wait_for_room(&self) {
        let mut inner = self.lock();
        while !inner.finished
            && !inner.draining
            && inner.sink.is_some()
            && inner.unacked >= UNACKED_PAUSE_BYTES
        {
            inner = self
                .changed
                .wait(inner)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// Turns back-pressure off for good; the shell is exiting and must be able to finish writing.
    pub fn start_draining(&self) {
        self.lock().draining = true;
        self.changed.notify_all();
    }

    /// The reader has read everything it will: held bytes go out now and the flusher stops.
    pub fn finish(&self) {
        let mut inner = self.lock();
        if let Some(held) = inner.coalescer.flush() {
            inner.send_data(&held);
        }
        inner.finished = true;
        drop(inner);
        self.changed.notify_all();
    }

    /// Records the shell's exit and tells the receiver, now or on its next attach. Held output goes
    /// first, so the exit frame is always the last one.
    pub fn set_exit(&self, code: i32) {
        let mut inner = self.lock();
        if let Some(held) = inner.coalescer.flush() {
            inner.send_data(&held);
        }
        inner.exit_code = Some(code);
        inner.deliver(encode_exit(code));
    }

    /// Waits until the reader has read everything it will, or `limit` passes.
    pub fn wait_finished(&self, limit: Duration) {
        let deadline = Instant::now() + limit;
        let mut inner = self.lock();
        while !inner.finished {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return;
            }
            inner = self
                .changed
                .wait_timeout(inner, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }

    /// Sends held bytes once their window has elapsed; returns when the stream is finished. Run on a
    /// dedicated thread.
    pub fn run_flusher(&self) {
        let mut inner = self.lock();
        loop {
            let now = Instant::now();
            if let Some(held) = inner.coalescer.poll(now) {
                inner.send_data(&held);
                continue;
            }
            if inner.finished {
                return;
            }
            inner = match inner.coalescer.time_until_due(now) {
                Some(wait) => {
                    self.changed
                        .wait_timeout(inner, wait)
                        .unwrap_or_else(PoisonError::into_inner)
                        .0
                }
                None => self
                    .changed
                    .wait(inner)
                    .unwrap_or_else(PoisonError::into_inner),
            };
        }
    }

    /// Everything the ring holds, oldest first.
    pub fn ring_snapshot(&self) -> Vec<u8> {
        self.lock().ring.snapshot()
    }

    /// The raw bytes of the most recent command's output, or `None` without prompt markers to name one.
    pub fn recent_command(&self) -> Option<Vec<u8>> {
        let inner = self.lock();
        extract_recent_command(
            &inner.ring.snapshot(),
            inner.ring.start(),
            &inner.markers.offsets(),
        )
    }

    /// The last `n` lines the ring holds.
    pub fn tail_lines(&self, n: usize) -> Vec<u8> {
        self.lock().ring.tail_lines(n)
    }
}

impl Default for Stream {
    fn default() -> Self {
        Self::new()
    }
}

/// Feeds `reader` into `stream` until end of input, pausing while an attached receiver is behind.
/// `answer_cursor_query` runs once per query that nobody attached could answer.
pub fn run_reader(stream: &Stream, mut reader: impl Read, mut answer_cursor_query: impl FnMut()) {
    let mut block = vec![0u8; READ_BLOCK_BYTES];
    loop {
        stream.wait_for_room();
        match reader.read(&mut block) {
            Ok(0) => break,
            Ok(read) => {
                for _ in 0..stream.ingest(&block[..read], Instant::now()) {
                    answer_cursor_query();
                }
            }
            Err(err) if err.kind() == ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    stream.finish();
}

#[cfg(test)]
#[path = "stream.test.rs"]
mod tests;
