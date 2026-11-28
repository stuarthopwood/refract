use std::time::Duration;

use super::*;

#[test]
fn main_window_may_call_terminal_channels() {
    assert!(refuse_caller("terminal.create", "main").is_none());
    assert!(refuse_caller("terminal.input", "main").is_none());
}

#[test]
fn other_windows_are_refused_with_terminal_refused() {
    for channel in ["terminal.create", "terminal.probe", "terminal.input"] {
        let refusal = refuse_caller(channel, "preview").expect("refused");
        assert_eq!(refusal["ok"], false);
        assert_eq!(refusal["error"]["code"], "terminal-refused");
    }
}

#[test]
fn non_terminal_channels_are_not_this_guards_business() {
    assert!(refuse_caller("sessions.list", "preview").is_none());
    assert!(refuse_caller("terminalish", "preview").is_none());
}

#[test]
fn the_refusal_never_names_the_channel_arguments() {
    let refusal = refuse_caller("terminal.input", "preview").unwrap();
    assert!(!refusal["error"]["message"]
        .as_str()
        .unwrap()
        .contains("terminal.input"));
}

#[test]
fn names_are_trimmed() {
    assert_eq!(validate_name("  build  ").unwrap(), "build");
}

#[test]
fn names_of_one_to_forty_characters_pass() {
    assert!(validate_name("x").is_ok());
    assert!(validate_name(&"x".repeat(40)).is_ok());
}

#[test]
fn empty_blank_and_overlong_names_are_invalid_arguments() {
    for bad in ["", "   ", "\t\n", &"x".repeat(41)] {
        let err = validate_name(bad).unwrap_err();
        assert_eq!(err.code, "invalid-argument", "{bad:?}");
    }
}

#[test]
fn the_name_limit_counts_characters_not_bytes() {
    // 40 two-byte characters are 80 bytes but within the limit; 41 are not.
    assert!(validate_name(&"é".repeat(40)).is_ok());
    assert!(validate_name(&"é".repeat(41)).is_err());
}

#[test]
fn trimming_happens_before_the_length_check() {
    let padded = format!("  {}  ", "x".repeat(40));
    assert_eq!(validate_name(&padded).unwrap().len(), 40);
}

#[test]
fn sizes_inside_the_range_are_kept() {
    assert_eq!(clamp_size(80, 24), (80, 24));
    assert_eq!(clamp_size(1, 1), (1, 1));
    assert_eq!(clamp_size(500, 200), (500, 200));
}

#[test]
fn sizes_outside_the_range_are_clamped_not_rejected() {
    assert_eq!(clamp_size(0, 0), (1, 1));
    assert_eq!(clamp_size(-5, -1), (1, 1));
    assert_eq!(clamp_size(501, 201), (500, 200));
    assert_eq!(clamp_size(i64::MAX, i64::MIN), (500, 1));
}

#[test]
fn input_up_to_64_kib_passes() {
    assert!(validate_input_size("").is_ok());
    assert!(validate_input_size(&"a".repeat(65_536)).is_ok());
}

#[test]
fn input_over_64_kib_is_refused() {
    let err = validate_input_size(&"a".repeat(65_537)).unwrap_err();
    assert_eq!(err.code, "invalid-argument");
}

#[test]
fn input_size_is_measured_in_bytes() {
    // 32 769 two-byte characters are 65 538 bytes.
    assert!(validate_input_size(&"é".repeat(32_769)).is_err());
    assert!(validate_input_size(&"é".repeat(32_768)).is_ok());
}

#[test]
fn a_full_bucket_accepts_one_megabyte_at_once() {
    let t0 = Instant::now();
    let mut limiter = RateLimiter::new(t0);
    for _ in 0..16 {
        limiter.try_consume(65_536, t0).unwrap();
    }
    let err = limiter.try_consume(1, t0).unwrap_err();
    assert_eq!(err.code, "terminal-rate-limited");
}

#[test]
fn a_refused_call_spends_nothing() {
    let t0 = Instant::now();
    let mut limiter = RateLimiter::new(t0);
    limiter.try_consume(1_048_000, t0).unwrap();
    assert!(limiter.try_consume(1_000, t0).is_err());
    // 576 bytes remain; the refused 1 000 did not eat into them.
    limiter.try_consume(576, t0).unwrap();
}

#[test]
fn tokens_refill_with_time() {
    let t0 = Instant::now();
    let mut limiter = RateLimiter::new(t0);
    limiter.try_consume(INPUT_RATE_BYTES_PER_SEC, t0).unwrap();
    assert!(limiter.try_consume(1, t0).is_err());
    // Half a second refills half the bucket.
    let t1 = t0 + Duration::from_millis(500);
    limiter
        .try_consume(INPUT_RATE_BYTES_PER_SEC / 2, t1)
        .unwrap();
    assert!(limiter.try_consume(1_000, t1).is_err());
}

#[test]
fn idle_time_never_banks_more_than_one_second() {
    let t0 = Instant::now();
    let mut limiter = RateLimiter::new(t0);
    let later = t0 + Duration::from_secs(3600);
    limiter
        .try_consume(INPUT_RATE_BYTES_PER_SEC, later)
        .unwrap();
    assert!(limiter.try_consume(1, later).is_err());
}

#[test]
fn a_sustained_rate_under_the_limit_is_never_refused() {
    let t0 = Instant::now();
    let mut limiter = RateLimiter::new(t0);
    // 64 KiB every 100 ms is 640 KiB/s.
    for step in 0..100u64 {
        let now = t0 + Duration::from_millis(step * 100);
        limiter.try_consume(65_536, now).unwrap();
    }
}

#[test]
fn a_sustained_rate_over_the_limit_is_eventually_refused() {
    let t0 = Instant::now();
    let mut limiter = RateLimiter::new(t0);
    // 64 KiB every 10 ms is 6.4 MiB/s.
    let refused = (0..200u64).any(|step| {
        limiter
            .try_consume(65_536, t0 + Duration::from_millis(step * 10))
            .is_err()
    });
    assert!(refused);
}
