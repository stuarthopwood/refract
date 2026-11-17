// Cascade and stale-relationship tests for the end tools. Each test uses its own repository id:
// the tree gate is process-wide, so a shared id would let parallel tests hold it against each other.

use std::time::Duration;

use tokio::sync::Barrier;

use super::super::sessions_end::hooks::WhileShuttingDown;
use super::super::sessions_end::tests::{host_in, parts, row, FakeHost, WhileAsking};
use super::*;

fn unique_repo() -> String {
    format!("repo-{}", uuid::Uuid::new_v4())
}

fn tree(repo: &str) -> Vec<Session> {
    vec![
        row("me", repo, None),
        row("kid", repo, Some("me")),
        row("grandkid", repo, Some("kid")),
    ]
}

async fn fresh() -> FakeHost {
    let repo = unique_repo();
    host_in(&repo, tree(&repo)).await
}

fn cascade() -> Value {
    json!({ "id": "kid", "include_children": true })
}

fn events(h: &FakeHost) -> Vec<String> {
    h.probe.events.lock().unwrap().clone()
}

#[tokio::test]
async fn a_cascade_stops_only_running_members_then_archives_deepest_first() {
    let h = Arc::new(fresh().await);
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
    let h = fresh().await;
    *h.probe.barrier.lock().unwrap() = Some(Arc::new(Barrier::new(2)));
    let h = Arc::new(h);
    // A sequential loop never gets the second shutdown to the barrier, so it times out.
    let out = tokio::time::timeout(
        Duration::from_secs(5),
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
    let h = fresh().await;
    let late = row("late", &h.probe.repo, Some("kid"));
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
        let h = fresh().await;
        *h.while_asking.lock().unwrap() = Some(WhileAsking::Unparent("kid".into()));
        let h = Arc::new(h);
        let err = run_with(&h, tool, &json!({ "id": "kid" }))
            .await
            .unwrap_err();
        assert_eq!(err.code, CANCELLED, "{tool:?}");
        assert!(
            err.message.contains("nothing was changed"),
            "{}",
            err.message
        );
        assert!(
            !err.message.contains("agents had already been stopped"),
            "{}",
            err.message
        );
        assert!(h.calls().is_empty(), "{tool:?}");
        assert!(h.shutdowns.lock().unwrap().is_empty(), "{tool:?}");
    }
}

#[tokio::test]
async fn a_caller_removed_while_agents_stop_refuses_and_says_they_were_stopped() {
    let h = fresh().await;
    *h.probe.change.lock().unwrap() = Some(WhileShuttingDown::Remove("me".into()));
    let h = Arc::new(h);
    let err = run_with(&h, EndTool::Archive, &cascade())
        .await
        .unwrap_err();
    assert_eq!(err.code, CANCELLED);
    assert!(
        err.message
            .ends_with("(the agents had already been stopped)"),
        "{}",
        err.message
    );
    assert!(!events(&h).iter().any(|e| e.starts_with("archive:")));
}

#[tokio::test]
async fn a_refusal_before_any_agent_stops_carries_no_stopped_suffix() {
    let repo = unique_repo();
    let rows = vec![row("me", &repo, None), row("other", &repo, None)];
    let h = host_in(&repo, rows).await;
    *h.while_asking.lock().unwrap() = Some(WhileAsking::Remove("me".into()));
    let h = Arc::new(h);
    let err = run_with(&h, EndTool::Archive, &json!({ "id": "other" }))
        .await
        .unwrap_err();
    assert_eq!(err.code, CANCELLED);
    assert!(
        !err.message.contains("already been stopped"),
        "{}",
        err.message
    );
    assert!(h.calls().is_empty());
}

#[tokio::test]
async fn a_cascade_outside_the_callers_tree_says_so_on_every_line() {
    let repo = unique_repo();
    let rows = vec![
        row("me", &repo, None),
        row("other", &repo, None),
        row("otherkid", &repo, Some("other")),
    ];
    let h = Arc::new(host_in(&repo, rows).await);
    let args = json!({ "id": "other", "include_children": true });
    run_with(&h, EndTool::Archive, &args).await.unwrap();
    let cards = h.cards.lock().unwrap();
    assert_eq!(cards.len(), 1);
    assert_eq!(
        parts(&cards[0]),
        (
            "Archive 2 Sessions".to_string(),
            vec![
                "other name-other (Outside this Session's tree)".to_string(),
                "otherkid name-otherkid (Outside this Session's tree)".to_string(),
            ]
        )
    );
}
