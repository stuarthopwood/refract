// Cascade and stale-relationship tests for the end tools, split from `sessions_end_tools.test.rs`
// for the 600-line cap.

use std::time::Duration;

use tokio::sync::Barrier;

use super::super::sessions_end::hooks::WhileShuttingDown;
use super::super::sessions_end::tests::{host, row, WhileAsking};
use super::*;

fn tree() -> Vec<Session> {
    vec![
        row("me", "repo", None),
        row("kid", "repo", Some("me")),
        row("grandkid", "repo", Some("kid")),
    ]
}

fn cascade() -> Value {
    json!({ "id": "kid", "include_children": true })
}

fn events(h: &super::super::sessions_end::tests::FakeHost) -> Vec<String> {
    h.probe.events.lock().unwrap().clone()
}

#[tokio::test]
async fn a_cascade_stops_only_running_members_then_archives_deepest_first() {
    let h = Arc::new(host(tree()).await);
    h.statuses
        .lock()
        .unwrap()
        .insert("grandkid".into(), "stopped".into());
    run_with(&h, EndTool::Archive, &cascade()).await.unwrap();
    // The stopped member needs no shutdown.
    assert_eq!(*h.shutdowns.lock().unwrap(), ["kid"]);
    assert_eq!(h.calls(), ["archive:grandkid", "archive:kid"]);
}

#[tokio::test]
async fn a_cascade_shuts_agents_down_concurrently_before_the_first_archive() {
    let h = host(tree()).await;
    *h.probe.barrier.lock().unwrap() = Some(Arc::new(Barrier::new(2)));
    let h = Arc::new(h);
    // A sequential loop never gets the second shutdown to the barrier, so it times out. The
    // generous bound covers other tests holding the shared tree gate.
    let out = tokio::time::timeout(
        Duration::from_secs(30),
        run_with(&h, EndTool::Archive, &cascade()),
    )
    .await
    .expect("shutdowns must run concurrently")
    .unwrap();
    assert_eq!(out["ids"], json!(["kid", "grandkid"]));
    let log = events(&h);
    let first_archive = log.iter().position(|e| e.starts_with("archive:")).unwrap();
    assert_eq!(log.iter().filter(|e| e.starts_with("shutdown:")).count(), 2);
    assert!(
        log[..first_archive]
            .iter()
            .all(|e| e.starts_with("shutdown:")),
        "{log:?}"
    );
    assert_eq!(log[first_archive..], ["archive:grandkid", "archive:kid"]);
}

#[tokio::test]
async fn a_tree_change_while_agents_stop_cancels_before_any_archive() {
    let h = host(tree()).await;
    let late = row("late", "repo", Some("kid"));
    *h.probe.change.lock().unwrap() = Some(WhileShuttingDown::Add(Box::new(late)));
    let h = Arc::new(h);
    let err = run_with(&h, EndTool::Archive, &cascade())
        .await
        .unwrap_err();
    assert_eq!(err.code, CANCELLED);
    assert!(
        err.message.contains("agents had already been stopped"),
        "{}",
        err.message
    );
    assert!(
        !err.message.contains("nothing was changed"),
        "{}",
        err.message
    );
    assert!(!events(&h).iter().any(|e| e.starts_with("archive:")));
    assert_eq!(
        *h.probe.gate_was_free.lock().unwrap(),
        Some(true),
        "the tree gate must be free while agents stop"
    );
}

#[tokio::test]
async fn a_target_that_leaves_the_own_tree_while_the_card_is_open_cancels_the_call() {
    for tool in [EndTool::Stop, EndTool::Archive] {
        let h = host(tree()).await;
        *h.while_asking.lock().unwrap() = Some(WhileAsking::Unparent("kid".into()));
        let h = Arc::new(h);
        let err = run_with(&h, tool, &json!({ "id": "kid" }))
            .await
            .unwrap_err();
        assert_eq!(err.code, CANCELLED, "{tool:?}");
        assert!(h.calls().is_empty(), "{tool:?}");
        assert!(h.shutdowns.lock().unwrap().is_empty(), "{tool:?}");
    }
}
