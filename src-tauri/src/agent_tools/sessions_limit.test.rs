use super::*;

fn fill(limiter: &SendLimiter, from: &str, to: &str, at: Instant) {
    for _ in 0..MAX_SENDS {
        limiter.try_acquire(from, to, at).unwrap();
    }
}

#[test]
fn the_eleventh_send_in_the_window_is_refused() {
    let limiter = SendLimiter::default();
    let start = Instant::now();
    fill(&limiter, "a", "b", start);
    assert!(limiter
        .try_acquire("a", "b", start + Duration::from_secs(1))
        .is_err());
}

#[test]
fn ten_sends_are_allowed() {
    let limiter = SendLimiter::default();
    let start = Instant::now();
    for _ in 0..MAX_SENDS {
        assert!(limiter.try_acquire("a", "b", start).is_ok());
    }
}

#[test]
fn the_window_slides() {
    let limiter = SendLimiter::default();
    let start = Instant::now();
    fill(&limiter, "a", "b", start);
    assert!(limiter.try_acquire("a", "b", start + WINDOW).is_ok());
}

#[test]
fn the_refusal_names_the_wait() {
    let limiter = SendLimiter::default();
    let start = Instant::now();
    fill(&limiter, "a", "b", start);
    let wait = limiter
        .try_acquire("a", "b", start + Duration::from_secs(100))
        .unwrap_err();
    assert_eq!(wait, 500);
}

#[test]
fn pairs_are_independent_and_directional() {
    let limiter = SendLimiter::default();
    let start = Instant::now();
    fill(&limiter, "a", "b", start);
    assert!(limiter.try_acquire("a", "c", start).is_ok());
    assert!(limiter.try_acquire("b", "a", start).is_ok());
}

#[test]
fn a_refused_acquire_counts_nothing() {
    let limiter = SendLimiter::default();
    let start = Instant::now();
    fill(&limiter, "a", "b", start);
    let refused_at = start + Duration::from_secs(1);
    for _ in 0..MAX_SENDS {
        assert!(limiter.try_acquire("a", "b", refused_at).is_err());
    }
    // Counted refusals at `refused_at` would still fill the pair when the first ten expire.
    assert!(limiter.try_acquire("a", "b", start + WINDOW).is_ok());
}

#[test]
fn a_released_slot_can_be_used_again() {
    let limiter = SendLimiter::default();
    let start = Instant::now();
    fill(&limiter, "a", "b", start);
    limiter.release("a", "b", start);
    assert!(limiter.try_acquire("a", "b", start).is_ok());
    assert!(limiter.try_acquire("a", "b", start).is_err());
}

#[test]
fn release_removes_only_the_named_slot() {
    let limiter = SendLimiter::default();
    let start = Instant::now();
    let later = start + Duration::from_secs(5);
    limiter.try_acquire("a", "b", start).unwrap();
    limiter.try_acquire("a", "b", later).unwrap();
    limiter.release("a", "b", later);
    let sends = limiter.sends.lock().unwrap();
    assert_eq!(sends[&("a".to_string(), "b".to_string())].len(), 1);
}

#[test]
fn releasing_the_last_slot_drops_the_pair() {
    let limiter = SendLimiter::default();
    let start = Instant::now();
    limiter.try_acquire("a", "b", start).unwrap();
    limiter.release("a", "b", start);
    assert!(limiter.sends.lock().unwrap().is_empty());
}

#[test]
fn expired_pairs_are_dropped_on_acquire() {
    let limiter = SendLimiter::default();
    let start = Instant::now();
    limiter.try_acquire("a", "b", start).unwrap();
    limiter.try_acquire("c", "d", start + WINDOW).unwrap();
    assert_eq!(limiter.sends.lock().unwrap().len(), 1);
}

#[test]
fn concurrent_acquires_never_exceed_the_limit() {
    let limiter = SendLimiter::default();
    let now = Instant::now();
    let granted = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..64 {
            scope.spawn(|| {
                if limiter.try_acquire("a", "b", now).is_ok() {
                    granted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
            });
        }
    });
    assert_eq!(granted.into_inner(), MAX_SENDS);
}
