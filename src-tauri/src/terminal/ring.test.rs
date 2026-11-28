use super::*;

fn assert_invariants(ring: &Ring) {
    assert!(ring.len() <= ring.capacity);
    assert_eq!(ring.total_written() - ring.start(), ring.len() as u64);
}

#[test]
fn keeps_everything_below_capacity() {
    let mut ring = Ring::with_capacity(16);
    ring.push(b"abc\n");
    ring.push(b"def\n");
    assert_eq!(ring.snapshot(), b"abc\ndef\n");
    assert_eq!(ring.start(), 0);
    assert_eq!(ring.total_written(), 8);
    assert_invariants(&ring);
}

#[test]
fn never_exceeds_capacity() {
    let mut ring = Ring::with_capacity(8);
    for _ in 0..20 {
        ring.push(b"xy\n");
        assert_invariants(&ring);
    }
    assert!(ring.len() <= 8);
    assert_eq!(ring.total_written(), 60);
}

#[test]
fn drops_oldest_bytes_first() {
    let mut ring = Ring::with_capacity(8);
    ring.push(b"aa\nbb\ncc\n");
    // 9 bytes into 8: the lone dropped byte splits "aa", so the rest of that line goes too and "bb" starts the ring.
    assert_eq!(ring.snapshot(), b"bb\ncc\n");
    assert_eq!(ring.start(), 3);
    assert_invariants(&ring);
}

#[test]
fn resumes_after_the_next_newline_when_the_cut_splits_a_line() {
    let mut ring = Ring::with_capacity(10);
    ring.push(b"first line\n");
    ring.push(b"ab\ncd");
    // The cut leaves "line\nab\ncd"; "line" is the tail of a split line, so it is dropped with its newline.
    assert_eq!(ring.snapshot(), b"ab\ncd");
    assert_eq!(ring.start(), 11);
    assert_invariants(&ring);
}

#[test]
fn line_boundary_resume_lands_exactly_after_the_newline() {
    let mut ring = Ring::with_capacity(12);
    ring.push(b"0123456789\n");
    ring.push(b"AB\nCD");
    // The cut drops "0123", leaving "456789\nAB\nCD"; the split "456789" line goes.
    assert_eq!(ring.snapshot(), b"AB\nCD");
    assert_invariants(&ring);
}

#[test]
fn a_single_line_longer_than_the_ring_keeps_its_tail() {
    let mut ring = Ring::with_capacity(8);
    ring.push(b"0123456789abcdef");
    assert_eq!(ring.snapshot(), b"89abcdef");
    assert_eq!(ring.start(), 8);
    assert_invariants(&ring);
}

#[test]
fn a_single_long_line_pushed_in_pieces_keeps_its_tail() {
    let mut ring = Ring::with_capacity(8);
    for chunk in [&b"0123"[..], b"4567", b"89ab", b"cdef"] {
        ring.push(chunk);
        assert_invariants(&ring);
    }
    assert_eq!(ring.snapshot(), b"89abcdef");
}

#[test]
fn a_chunk_larger_than_the_ring_skips_a_partial_first_line() {
    let mut ring = Ring::with_capacity(8);
    ring.push(b"junk junk\nXY\nZZZ");
    // Tail of 8 is "\nXY\nZZZ"-shaped: "k\nXY\nZZZ"[..]; the cut splits "junk junk", so "k\n" goes.
    assert_eq!(ring.snapshot(), b"XY\nZZZ");
    assert_invariants(&ring);
}

#[test]
fn an_exact_fit_drops_nothing() {
    let mut ring = Ring::with_capacity(4);
    ring.push(b"ab\nc");
    assert_eq!(ring.snapshot(), b"ab\nc");
    assert_eq!(ring.start(), 0);
}

#[test]
fn a_cut_on_a_line_boundary_keeps_the_next_line_whole() {
    let mut ring = Ring::with_capacity(6);
    ring.push(b"ab\ncd");
    ring.push(b"ef\ng");
    // 9 bytes into 6: the dropped bytes are exactly "ab\n", a whole line, so "cdef\ng" survives untouched.
    assert_eq!(ring.snapshot(), b"cdef\ng");
    assert_eq!(ring.start(), 3);
    assert_invariants(&ring);
}

#[test]
fn tail_lines_returns_the_last_n_lines() {
    let mut ring = Ring::with_capacity(64);
    ring.push(b"one\ntwo\nthree\nfour\n");
    assert_eq!(ring.tail_lines(2), b"three\nfour\n");
    assert_eq!(ring.tail_lines(1), b"four\n");
    assert_eq!(ring.tail_lines(10), b"one\ntwo\nthree\nfour\n");
    assert_eq!(ring.tail_lines(0), b"");
}

#[test]
fn tail_lines_counts_an_unterminated_last_line() {
    let mut ring = Ring::with_capacity(64);
    ring.push(b"one\ntwo\nprompt> ");
    assert_eq!(ring.tail_lines(1), b"prompt> ");
    assert_eq!(ring.tail_lines(2), b"two\nprompt> ");
}

#[test]
fn an_empty_ring_has_no_lines() {
    let ring = Ring::with_capacity(8);
    assert!(ring.is_empty());
    assert_eq!(ring.tail_lines(5), b"");
    assert_eq!(ring.snapshot(), b"");
    assert_eq!(ring.start(), 0);
}

#[test]
fn the_default_ring_holds_the_scrollback_figure() {
    let ring = Ring::default();
    assert_eq!(ring.capacity, SCROLLBACK_BYTES);
}
