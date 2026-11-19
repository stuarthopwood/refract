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

#[tokio::test]
async fn an_action_that_outruns_the_deadline_fails_unretried_and_frees_the_gate() {
    let mut fx = fake(vec![]).await;
    fx.hang = true;
    let args = json!({ "prompt": "build it", "session_id": "kid" });
    // Set up first: the paused clock jumps ahead whenever the runtime idles on real I/O.
    tokio::time::pause();

    let err = run_with(&fx, ConvTool::New, &args).await.unwrap_err();

    assert_eq!(err.code, OUTCOME_UNKNOWN);
    assert!(
        err.message.contains("took longer than 90 seconds"),
        "{}",
        err.message
    );
    // One queue and one start were tried, and none was repeated under the gate.
    assert_eq!(*fx.held.lock().unwrap(), [true, true]);
    assert!(
        gate_is_free(&fx).await,
        "a timed-out action must free the gate"
    );
}
