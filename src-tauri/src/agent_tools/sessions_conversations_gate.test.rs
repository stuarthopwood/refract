// The Project's tree gate around a Conversation action (#1861): held for a cross-Session action,
// never for a self-handoff, and never longer than the action deadline.

use super::*;

async fn gate_is_free(fx: &ConvFake) -> bool {
    tokio::time::timeout(Duration::from_millis(50), tree_gate::lock(&fx.repo))
        .await
        .is_ok()
}

#[tokio::test]
async fn the_tree_gate_is_held_while_the_action_runs_and_freed_after() {
    let fx = fake(vec![]).await;
    let args = json!({ "prompt": "build it", "session_id": "side" });

    run_with(&fx, ConvTool::New, &args).await.unwrap();

    assert_eq!(*fx.held.lock().unwrap(), [true, true]);
    assert!(
        gate_is_free(&fx).await,
        "the gate must be released on return"
    );
}

#[tokio::test]
async fn a_self_handoff_takes_no_tree_gate() {
    let fx = fake(vec![]).await;

    run_with(&fx, ConvTool::New, &json!({ "prompt": "note" }))
        .await
        .unwrap();

    assert_eq!(*fx.held.lock().unwrap(), [false, false]);
    assert!(gate_is_free(&fx).await);
}

#[tokio::test]
async fn recheck_locks_for_another_session_and_not_for_its_own() {
    let fx = fake(vec![]).await;
    let own = open_gate(&fx, None, true).await.unwrap();
    let kid = open_gate(&fx, Some("kid"), true).await.unwrap();

    let own_guard = recheck(&fx, &own, false).await.unwrap().1;
    let kid_guard = recheck(&fx, &kid, false).await.unwrap().1;

    assert!(own_guard.is_none());
    assert!(kid_guard.is_some());
    assert!(!gate_is_free(&fx).await, "the kid's guard holds the gate");
    drop(kid_guard);
    assert!(gate_is_free(&fx).await);
}

/// Polls until `done`, so a task that outlives the call has time to finish.
async fn eventually(mut done: impl FnMut() -> bool) {
    for _ in 0..200 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the detached action never finished");
}

fn started(fx: &ConvFake) -> bool {
    fx.calls().iter().any(|c| c.starts_with("start:"))
}

/// Runs a call whose `start_new` waits for `release`, and returns what the caller was told once it
/// stopped waiting at the deadline.
async fn call_past_the_deadline(fx: &ConvFake) -> ToolError {
    let args = json!({ "prompt": "build it", "session_id": "kid" });
    // Set up first: the paused clock jumps ahead whenever the runtime idles on real I/O.
    tokio::time::pause();
    // The outer timeout turns a regression that waits for the action into a failure, not a hang.
    tokio::time::timeout(Duration::from_secs(120), run_with(fx, ConvTool::New, &args))
        .await
        .expect("the caller must return at the action deadline")
        .unwrap_err()
}

#[tokio::test]
async fn a_slow_action_outlives_the_deadline_and_keeps_the_gate_until_it_ends() {
    let mut fx = fake(vec![]).await;
    fx.hang = true;

    let err = call_past_the_deadline(&fx).await;

    assert_eq!(err.code, OUTCOME_UNKNOWN);
    assert!(
        err.message.contains("still running after 90 seconds"),
        "{}",
        err.message
    );
    assert!(!started(&fx), "the action is still waiting on omp");
    assert!(
        !gate_is_free(&fx).await,
        "the action keeps the gate after its caller stopped waiting"
    );

    fx.release.notify_one();
    eventually(|| started(&fx)).await;
    // The task frees the gate once the action is done, and it was never run a second time.
    assert!(gate_is_free(&fx).await);
    assert_eq!(*fx.held.lock().unwrap(), [true, true]);
    assert!(fx.late.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_failure_after_the_caller_stopped_waiting_is_reported_by_the_task() {
    let mut fx = fake(vec![]).await;
    fx.hang = true;
    fx.fail_start = true;

    call_past_the_deadline(&fx).await;
    fx.release.notify_one();

    eventually(|| !fx.late.lock().unwrap().is_empty()).await;
    assert_eq!(*fx.late.lock().unwrap(), ["kid:omp refused"]);
    assert!(gate_is_free(&fx).await);
}
