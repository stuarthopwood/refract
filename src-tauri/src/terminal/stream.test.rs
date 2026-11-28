// Behaviour of one tab's output path through its public surface: what a receiver is sent, in what order,
// and when the reader is held back. No real shell is involved.

use std::io::{Cursor, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::*;
use crate::terminal::frame::{TAG_DATA, TAG_EXIT};
use crate::terminal::limits::UNACKED_PAUSE_BYTES;

#[derive(Clone, Default)]
struct Recorder {
    frames: Arc<Mutex<Vec<Vec<u8>>>>,
    broken: Arc<AtomicBool>,
}

impl FrameSink for Recorder {
    fn send(&mut self, frame: Vec<u8>) -> bool {
        if self.broken.load(Ordering::SeqCst) {
            return false;
        }
        self.frames.lock().unwrap().push(frame);
        true
    }
}

impl Recorder {
    fn frames(&self) -> Vec<Vec<u8>> {
        self.frames.lock().unwrap().clone()
    }

    /// Payload of every data frame, joined.
    fn data(&self) -> Vec<u8> {
        self.frames()
            .iter()
            .filter(|frame| frame[0] == TAG_DATA)
            .flat_map(|frame| frame[1..].to_vec())
            .collect()
    }
}

fn wait_until(mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    false
}

#[test]
fn attaching_replays_the_ring_led_by_a_style_reset() {
    let stream = Stream::new();
    stream.ingest(b"hello\r\nworld", Instant::now());
    let recorder = Recorder::default();

    stream.attach(Box::new(recorder.clone()));

    assert_eq!(recorder.data(), b"\x1b[0mhello\r\nworld");
}

#[test]
fn live_output_follows_the_replay_in_order_without_repeats() {
    let stream = Stream::new();
    stream.ingest(b"old|", Instant::now());
    let recorder = Recorder::default();
    stream.attach(Box::new(recorder.clone()));

    stream.ingest(b"new|", Instant::now());
    stream.finish();

    assert_eq!(recorder.data(), b"\x1b[0mold|new|");
}

#[test]
fn a_detached_tab_keeps_recording_into_the_ring() {
    let stream = Stream::new();
    stream.ingest(b"one|", Instant::now());
    stream.ingest(b"two|", Instant::now());

    assert_eq!(stream.ring_snapshot(), b"one|two|");
    assert!(!stream.is_attached());
}

#[test]
fn output_is_held_for_the_window_then_sent_by_the_flusher() {
    let stream = Arc::new(Stream::new());
    let recorder = Recorder::default();
    stream.attach(Box::new(recorder.clone()));
    let baseline = recorder.frames().len();
    let flusher = {
        let stream = Arc::clone(&stream);
        std::thread::spawn(move || stream.run_flusher())
    };

    stream.ingest(b"burst", Instant::now());

    assert!(
        wait_until(|| recorder.frames().len() > baseline),
        "the held bytes should be sent once the window elapses"
    );
    assert_eq!(recorder.frames().last().unwrap(), &encode_data(b"burst"));
    stream.finish();
    flusher.join().unwrap();
}

#[test]
fn a_burst_becomes_one_frame_instead_of_many() {
    let stream = Stream::new();
    let recorder = Recorder::default();
    stream.attach(Box::new(recorder.clone()));
    let baseline = recorder.frames().len();
    let now = Instant::now();

    for _ in 0..10 {
        stream.ingest(b"x", now);
    }
    stream.finish();

    assert_eq!(recorder.frames().len(), baseline + 1);
    assert_eq!(recorder.frames().last().unwrap(), &encode_data(&[b'x'; 10]));
}

#[test]
fn a_long_replay_is_split_into_frames_within_the_frame_limit() {
    let stream = Stream::new();
    stream.ingest(&vec![b'a'; COALESCE_MAX_BYTES * 2 + 10], Instant::now());
    let recorder = Recorder::default();

    stream.attach(Box::new(recorder.clone()));

    let frames = recorder.frames();
    assert!(frames.len() >= 3);
    assert!(frames
        .iter()
        .all(|frame| frame.len() <= COALESCE_MAX_BYTES + 1));
    assert_eq!(recorder.data().len(), COALESCE_MAX_BYTES * 2 + 10 + 4);
}

#[test]
fn a_second_attach_replaces_the_first_receiver() {
    let stream = Stream::new();
    let first = Recorder::default();
    let second = Recorder::default();
    stream.attach(Box::new(first.clone()));
    let first_count = first.frames().len();

    stream.attach(Box::new(second.clone()));
    stream.ingest(b"later", Instant::now());
    stream.finish();

    assert_eq!(first.frames().len(), first_count);
    assert_eq!(second.data(), b"\x1b[0mlater");
}

#[test]
fn a_receiver_that_fails_is_dropped_and_not_sent_to_again() {
    let stream = Stream::new();
    let recorder = Recorder::default();
    stream.attach(Box::new(recorder.clone()));
    recorder.broken.store(true, Ordering::SeqCst);

    stream.ingest(b"lost?", Instant::now());
    stream.finish();

    assert!(!stream.is_attached());
    assert_eq!(stream.ring_snapshot(), b"lost?", "the ring still has it");
    // A later attach replays it.
    let next = Recorder::default();
    stream.attach(Box::new(next.clone()));
    assert_eq!(next.data(), b"\x1b[0mlost?");
}

#[test]
fn detach_stops_delivery_but_not_recording() {
    let stream = Stream::new();
    let recorder = Recorder::default();
    stream.attach(Box::new(recorder.clone()));
    stream.detach();
    let count = recorder.frames().len();

    stream.ingest(b"quiet", Instant::now());
    stream.finish();

    assert_eq!(recorder.frames().len(), count);
    assert_eq!(stream.ring_snapshot(), b"quiet");
}

#[test]
fn a_held_cursor_query_is_not_replayed_but_live_ones_pass_through() {
    let stream = Stream::new();
    stream.ingest(b"a\x1b[6nb", Instant::now());
    let recorder = Recorder::default();

    stream.attach(Box::new(recorder.clone()));
    assert_eq!(recorder.data(), b"\x1b[0mab");

    stream.ingest(b"c\x1b[6n", Instant::now());
    stream.finish();
    assert_eq!(recorder.data(), b"\x1b[0mabc\x1b[6n");
}

#[test]
fn a_cursor_query_split_across_reads_is_found_once() {
    let stream = Stream::new();
    let now = Instant::now();

    let first = stream.ingest(b"x\x1b[", now);
    let second = stream.ingest(b"6ny", now);

    assert_eq!((first, second), (0, 1));
}

#[test]
fn a_cursor_query_with_nobody_attached_is_reported_for_an_answer() {
    let stream = Stream::new();
    assert_eq!(stream.ingest(b"\x1b[6n\x1b[6n", Instant::now()), 2);

    stream.attach(Box::new(Recorder::default()));
    assert_eq!(
        stream.ingest(b"\x1b[6n", Instant::now()),
        0,
        "the attached terminal answers for itself"
    );
}

#[test]
fn the_exit_frame_follows_held_output_and_replays_on_a_later_attach() {
    let stream = Stream::new();
    let recorder = Recorder::default();
    stream.attach(Box::new(recorder.clone()));
    stream.ingest(b"bye", Instant::now());

    stream.set_exit(-3);

    let frames = recorder.frames();
    assert_eq!(frames[frames.len() - 2], encode_data(b"bye"));
    assert_eq!(frames[frames.len() - 1], encode_exit(-3));
    assert_eq!(frames[frames.len() - 1][0], TAG_EXIT);

    let late = Recorder::default();
    stream.attach(Box::new(late.clone()));
    let replayed = late.frames();
    assert_eq!(replayed.last().unwrap(), &encode_exit(-3));
    assert_eq!(late.data(), b"\x1b[0mbye");
}

/// Hands out `blocks` blocks of `READ_BLOCK_BYTES`, then end of input.
struct Blocks {
    left: usize,
}

impl Read for Blocks {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.left == 0 {
            return Ok(0);
        }
        self.left -= 1;
        buf[..READ_BLOCK_BYTES].fill(b'z');
        Ok(READ_BLOCK_BYTES)
    }
}

#[test]
fn the_reader_pauses_while_the_receiver_is_behind_and_resumes_on_ack() {
    let stream = Arc::new(Stream::new());
    stream.attach(Box::new(Recorder::default()));
    let total = 64;
    let reader = {
        let stream = Arc::clone(&stream);
        std::thread::spawn(move || run_reader(&stream, Blocks { left: total }, || {}))
    };

    assert!(wait_until(
        || stream.ring_snapshot().len() >= UNACKED_PAUSE_BYTES
    ));
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(
        stream.ring_snapshot().len(),
        UNACKED_PAUSE_BYTES,
        "the reader holds still once too much is unacknowledged"
    );

    // Keep acknowledging until the reader is done: it may pause again further on.
    while !reader.is_finished() {
        stream.ack(UNACKED_PAUSE_BYTES);
        std::thread::sleep(Duration::from_millis(5));
    }
    reader.join().unwrap();

    assert_eq!(stream.ring_snapshot().len(), total * READ_BLOCK_BYTES);
}

#[test]
fn a_detached_tab_is_never_held_back() {
    let stream = Stream::new();

    run_reader(&stream, Blocks { left: 64 }, || {});

    assert_eq!(stream.ring_snapshot().len(), 64 * READ_BLOCK_BYTES);
}

#[test]
fn detaching_releases_a_paused_reader() {
    let stream = Arc::new(Stream::new());
    stream.attach(Box::new(Recorder::default()));
    let reader = {
        let stream = Arc::clone(&stream);
        std::thread::spawn(move || run_reader(&stream, Blocks { left: 64 }, || {}))
    };
    assert!(wait_until(
        || stream.ring_snapshot().len() >= UNACKED_PAUSE_BYTES
    ));

    stream.detach();

    reader.join().unwrap();
    assert_eq!(stream.ring_snapshot().len(), 64 * READ_BLOCK_BYTES);
}

#[test]
fn draining_lets_a_paused_reader_finish() {
    let stream = Arc::new(Stream::new());
    stream.attach(Box::new(Recorder::default()));
    let reader = {
        let stream = Arc::clone(&stream);
        std::thread::spawn(move || run_reader(&stream, Blocks { left: 64 }, || {}))
    };
    assert!(wait_until(
        || stream.ring_snapshot().len() >= UNACKED_PAUSE_BYTES
    ));

    stream.start_draining();

    reader.join().unwrap();
    assert_eq!(stream.ring_snapshot().len(), 64 * READ_BLOCK_BYTES);
}

#[test]
fn the_reader_answers_each_cursor_query_nobody_could() {
    let stream = Stream::new();
    let mut answered = 0;

    run_reader(&stream, Cursor::new(b"a\x1b[6nb\x1b[6n".to_vec()), || {
        answered += 1;
    });

    assert_eq!(answered, 2);
    assert_eq!(stream.ring_snapshot(), b"a\x1b[6nb\x1b[6n");
}

#[test]
fn wait_finished_returns_once_the_reader_is_done_or_the_limit_passes() {
    let stream = Stream::new();
    let started = Instant::now();
    stream.wait_finished(Duration::from_millis(50));
    assert!(started.elapsed() >= Duration::from_millis(40));

    run_reader(&stream, Cursor::new(Vec::new()), || {});
    let started = Instant::now();
    stream.wait_finished(Duration::from_secs(5));
    assert!(started.elapsed() < Duration::from_secs(1));
}
