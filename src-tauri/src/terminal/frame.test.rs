use super::*;

#[test]
fn data_frame_is_tag_then_bytes() {
    assert_eq!(encode_data(b"hi"), vec![0x01, b'h', b'i']);
    assert_eq!(encode_data(b""), vec![0x01]);
}

#[test]
fn exit_frame_is_tag_then_little_endian_i32() {
    assert_eq!(encode_exit(0), vec![0x02, 0, 0, 0, 0]);
    assert_eq!(encode_exit(1), vec![0x02, 1, 0, 0, 0]);
    assert_eq!(encode_exit(0x0102_0304), vec![0x02, 4, 3, 2, 1]);
}

#[test]
fn exit_frame_keeps_negative_codes() {
    assert_eq!(encode_exit(-1), vec![0x02, 0xff, 0xff, 0xff, 0xff]);
    // Windows reports a killed or crashed process as a large unsigned status, seen here as negative.
    let frame = encode_exit(0xC000_013Au32 as i32);
    assert_eq!(
        i32::from_le_bytes(frame[1..5].try_into().unwrap()),
        0xC000_013Au32 as i32
    );
}

#[test]
fn small_output_waits_for_its_window() {
    let t0 = Instant::now();
    let mut co = Coalescer::new();
    assert!(co.push(b"abc", t0).is_empty());
    assert_eq!(co.poll(t0 + Duration::from_millis(7)), None);
    assert_eq!(co.poll(t0 + COALESCE_WINDOW), Some(b"abc".to_vec()));
    assert_eq!(co.poll(t0 + Duration::from_secs(1)), None);
}

#[test]
fn pieces_inside_one_window_become_one_frame() {
    let t0 = Instant::now();
    let mut co = Coalescer::new();
    assert!(co.push(b"a", t0).is_empty());
    assert!(co.push(b"b", t0 + Duration::from_millis(3)).is_empty());
    assert!(co.push(b"c", t0 + Duration::from_millis(6)).is_empty());
    assert_eq!(co.poll(t0 + COALESCE_WINDOW), Some(b"abc".to_vec()));
}

#[test]
fn a_push_after_the_window_returns_the_held_bytes_with_the_new_ones() {
    let t0 = Instant::now();
    let mut co = Coalescer::new();
    co.push(b"a", t0);
    let ready = co.push(b"b", t0 + Duration::from_millis(9));
    assert_eq!(ready, vec![b"ab".to_vec()]);
}

#[test]
fn reaching_the_size_cap_sends_at_once() {
    let t0 = Instant::now();
    let mut co = Coalescer::new();
    let ready = co.push(&vec![7u8; COALESCE_MAX_BYTES], t0);
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].len(), COALESCE_MAX_BYTES);
    assert_eq!(co.flush(), None);
}

#[test]
fn one_byte_below_the_cap_is_held() {
    let t0 = Instant::now();
    let mut co = Coalescer::new();
    assert!(co.push(&vec![7u8; COALESCE_MAX_BYTES - 1], t0).is_empty());
    assert_eq!(
        co.flush().map(|chunk| chunk.len()),
        Some(COALESCE_MAX_BYTES - 1)
    );
}

#[test]
fn a_large_push_splits_into_capped_chunks_and_keeps_the_remainder_waiting() {
    let t0 = Instant::now();
    let mut co = Coalescer::new();
    let data: Vec<u8> = (0..(COALESCE_MAX_BYTES * 2 + 10))
        .map(|i| (i % 251) as u8)
        .collect();
    let ready = co.push(&data, t0);
    assert_eq!(ready.len(), 2);
    assert!(ready.iter().all(|chunk| chunk.len() == COALESCE_MAX_BYTES));
    assert_eq!(
        co.poll(t0),
        None,
        "the 10-byte remainder waits for its own window"
    );
    let tail = co.poll(t0 + COALESCE_WINDOW).expect("remainder due");
    let rejoined: Vec<u8> = ready.into_iter().flatten().chain(tail).collect();
    assert_eq!(rejoined, data);
}

#[test]
fn time_until_due_counts_down_and_is_none_when_empty() {
    let t0 = Instant::now();
    let mut co = Coalescer::new();
    assert_eq!(co.time_until_due(t0), None);
    co.push(b"x", t0);
    assert_eq!(co.time_until_due(t0), Some(COALESCE_WINDOW));
    assert_eq!(
        co.time_until_due(t0 + Duration::from_millis(5)),
        Some(Duration::from_millis(3))
    );
    assert_eq!(
        co.time_until_due(t0 + Duration::from_millis(50)),
        Some(Duration::ZERO)
    );
    co.flush();
    assert_eq!(co.time_until_due(t0), None);
}

#[test]
fn empty_pushes_hold_nothing() {
    let t0 = Instant::now();
    let mut co = Coalescer::new();
    assert!(co.push(b"", t0).is_empty());
    assert_eq!(co.time_until_due(t0), None);
}
