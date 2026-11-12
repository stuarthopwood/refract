use super::*;

fn fill(limiter: &SendLimiter, from: &str, to: &str, at: Instant) {
    for _ in 0..MAX_SENDS {
        limiter.record(from, to, at);
    }
}

#[test]
fn the_eleventh_send_in_the_window_is_refused() {
    let limiter = SendLimiter::default();
    let start = Instant::now();
    fill(&limiter, "a", "b", start);
    assert!(limiter
        .check("a", "b", start + Duration::from_secs(1))
        .is_err());
}

#[test]
fn ten_sends_are_allowed() {
    let limiter = SendLimiter::default();
    let start = Instant::now();
    for _ in 0..MAX_SENDS - 1 {
        limiter.record("a", "b", start);
    }
    assert!(limiter.check("a", "b", start).is_ok());
}

#[test]
fn the_window_slides() {
    let limiter = SendLimiter::default();
    let start = Instant::now();
    fill(&limiter, "a", "b", start);
    assert!(limiter.check("a", "b", start + WINDOW).is_ok());
}

#[test]
fn the_refusal_names_the_wait() {
    let limiter = SendLimiter::default();
    let start = Instant::now();
    fill(&limiter, "a", "b", start);
    let wait = limiter
        .check("a", "b", start + Duration::from_secs(100))
        .unwrap_err();
    assert_eq!(wait, 500);
}

#[test]
fn pairs_are_independent_and_directional() {
    let limiter = SendLimiter::default();
    let start = Instant::now();
    fill(&limiter, "a", "b", start);
    assert!(limiter.check("a", "c", start).is_ok());
    assert!(limiter.check("b", "a", start).is_ok());
}

#[test]
fn a_check_alone_counts_nothing() {
    let limiter = SendLimiter::default();
    let start = Instant::now();
    for _ in 0..MAX_SENDS * 3 {
        assert!(limiter.check("a", "b", start).is_ok());
    }
}

#[test]
fn expired_pairs_are_dropped_on_record() {
    let limiter = SendLimiter::default();
    let start = Instant::now();
    limiter.record("a", "b", start);
    limiter.record("c", "d", start + WINDOW);
    assert_eq!(limiter.sends.lock().unwrap().len(), 1);
}
