use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::*;
use crate::agent_tools::router::INVALID_INPUT;
use crate::agent_tools::{MUTATION_TIMEOUT_MS, RENDERER_TIMEOUT_MS};

#[tokio::test(start_paused = true)]
async fn a_silent_renderer_times_out_with_the_timeout_code() {
    let router = ToolRouter::default();
    let rx = router.wait_for("c1");
    let wait = tokio::spawn(wait_renderer(rx));
    tokio::time::advance(Duration::from_millis(RENDERER_TIMEOUT_MS + 1)).await;
    assert_eq!(wait.await.unwrap().unwrap_err().code, TIMEOUT);
}

#[tokio::test]
async fn a_cancel_during_a_renderer_wait_returns_cancelled() {
    let router = ToolRouter::default();
    let _cancel = router.begin("c1").unwrap();
    let rx = router.wait_for("c1");
    router.drop_all();
    assert_eq!(wait_renderer(rx).await.unwrap_err().code, CANCELLED);
}

type Pending = tokio::task::JoinHandle<Result<Value, ToolError>>;

fn pending_mutation(router: &Arc<ToolRouter>) -> Pending {
    let started = router.wait_started("c1");
    let reply = router.wait_for("c1");
    let router = router.clone();
    tokio::spawn(async move { wait_mutation(&router, "c1", started, reply).await })
}

async fn advance_ms(ms: u64) {
    tokio::time::advance(Duration::from_millis(ms)).await;
}

fn code_of(result: Result<Value, ToolError>) -> String {
    result.unwrap_err().code
}

#[tokio::test(start_paused = true)]
async fn a_mutation_that_never_starts_times_out_at_exactly_its_window() {
    let router = Arc::new(ToolRouter::default());
    let wait = pending_mutation(&router);
    tokio::task::yield_now().await;
    advance_ms(MUTATION_TIMEOUT_MS - 1).await;
    tokio::task::yield_now().await;
    assert!(!wait.is_finished());
    advance_ms(1).await;
    let err = wait.await.unwrap().unwrap_err();
    assert_eq!(err.code, TIMEOUT);
    assert!(err.message.contains("nothing changed"));
    assert!(!router.started("c1"));
}

#[tokio::test(start_paused = true)]
async fn a_started_mutation_that_goes_silent_is_outcome_unknown_at_exactly_its_window() {
    let router = Arc::new(ToolRouter::default());
    let wait = pending_mutation(&router);
    tokio::task::yield_now().await;
    assert!(router.started("c1"));
    tokio::task::yield_now().await;
    advance_ms(MUTATION_TIMEOUT_MS - 1).await;
    tokio::task::yield_now().await;
    assert!(!wait.is_finished());
    advance_ms(1).await;
    let err = wait.await.unwrap().unwrap_err();
    assert_eq!(err.code, OUTCOME_UNKNOWN);
    assert!(err.message.contains("check the panel before you retry"));
}

#[tokio::test(start_paused = true)]
async fn a_started_racing_the_deadline_never_reports_timeout_after_being_accepted() {
    let router = Arc::new(ToolRouter::default());
    let wait = pending_mutation(&router);
    tokio::task::yield_now().await;
    advance_ms(MUTATION_TIMEOUT_MS).await;
    let accepted = router.started("c1");
    if accepted {
        tokio::task::yield_now().await;
        assert!(
            !wait.is_finished(),
            "an accepted started must keep waiting for the reply"
        );
        assert!(router.answer("c1", &json!({ "ok": true, "value": { "staged": true } })));
        assert_eq!(wait.await.unwrap(), Ok(json!({ "staged": true })));
    } else {
        assert_eq!(code_of(wait.await.unwrap()), TIMEOUT);
    }
}

#[tokio::test(start_paused = true)]
async fn the_reply_window_restarts_when_the_action_starts() {
    let router = Arc::new(ToolRouter::default());
    let wait = pending_mutation(&router);
    tokio::task::yield_now().await;
    advance_ms(MUTATION_TIMEOUT_MS - 1_000).await;
    assert!(router.started("c1"));
    tokio::task::yield_now().await;
    advance_ms(MUTATION_TIMEOUT_MS - 1_000).await;
    assert!(router.answer("c1", &json!({ "ok": true, "value": { "staged": true } })));
    assert_eq!(wait.await.unwrap(), Ok(json!({ "staged": true })));
}

#[tokio::test(start_paused = true)]
async fn a_reply_before_started_ends_the_call_with_the_reply() {
    let router = Arc::new(ToolRouter::default());
    let wait = pending_mutation(&router);
    tokio::task::yield_now().await;
    let reply = json!({ "ok": false, "error": { "code": "invalid_input", "message": "m" } });
    assert!(router.answer("c1", &reply));
    assert_eq!(code_of(wait.await.unwrap()), INVALID_INPUT);
    assert!(!router.started("c1"));
}

#[tokio::test(start_paused = true)]
async fn a_cancel_ends_a_mutation_before_and_after_it_started() {
    let router = Arc::new(ToolRouter::default());
    let before = pending_mutation(&router);
    tokio::task::yield_now().await;
    router.drop_all();
    assert_eq!(code_of(before.await.unwrap()), CANCELLED);

    let after = pending_mutation(&router);
    tokio::task::yield_now().await;
    assert!(router.started("c1"));
    router.drop_all();
    assert_eq!(code_of(after.await.unwrap()), CANCELLED);
}

#[tokio::test(start_paused = true)]
async fn a_read_keeps_its_ten_second_window_and_has_no_started_signal() {
    let router = Arc::new(ToolRouter::default());
    let rx = router.wait_for("c1");
    assert!(!router.started("c1"));
    let wait = tokio::spawn(wait_renderer(rx));
    tokio::task::yield_now().await;
    advance_ms(RENDERER_TIMEOUT_MS + 1).await;
    assert_eq!(code_of(wait.await.unwrap()), TIMEOUT);
}

#[test]
fn started_is_refused_once_the_call_has_finished() {
    let router = ToolRouter::default();
    let _started = router.wait_started("c1");
    router.finish("c1");
    assert!(!router.started("c1"));
}

#[test]
fn started_resolves_only_inside_its_own_router() {
    let a = ToolRouter::default();
    let b = ToolRouter::default();
    let _started = a.wait_started("c1");
    assert!(!b.started("c1"));
    assert!(a.started("c1"));
    assert!(!a.started("c1"));
}

/// Real threads and a real clock: `started` lands anywhere from just before the window ends to
/// just after the deadline path has begun, which a paused single-thread clock cannot reach.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn started_racing_the_deadline_on_real_threads_never_loses_an_accepted_start() {
    const ROUNDS: usize = 60;
    const CALLS: usize = 48;
    let window = Duration::from_millis(2);
    let router = Arc::new(ToolRouter::default());
    let (mut accepted_total, mut refused_total) = (0, 0);
    for round in 0..ROUNDS {
        let base = std::time::Instant::now();
        let mut calls = Vec::with_capacity(CALLS);
        for i in 0..CALLS {
            let id = format!("r{round}-{i}");
            let started = router.wait_started(&id);
            let reply = router.wait_for(&id);
            let wait_router = router.clone();
            let wait_id = id.clone();
            let wait = tokio::spawn(async move {
                wait_mutation_within(window, &wait_router, &wait_id, started, reply).await
            });
            let start_router = router.clone();
            // Staggered across the timer tick so some starts land on each side of the deadline.
            let at = base + window + Duration::from_micros(25 * i as u64);
            let start = tokio::task::spawn_blocking(move || {
                while std::time::Instant::now() < at {
                    std::hint::spin_loop();
                }
                start_router.started(&id)
            });
            calls.push((wait, start));
        }
        for (wait, start) in calls {
            let accepted = start.await.unwrap();
            let code = code_of(wait.await.unwrap());
            if accepted {
                accepted_total += 1;
                assert_ne!(
                    code, TIMEOUT,
                    "an accepted start was reported as a safe timeout"
                );
            } else {
                refused_total += 1;
                assert_eq!(code, TIMEOUT);
            }
        }
    }
    eprintln!("race outcomes: accepted={accepted_total} refused={refused_total}");
}
