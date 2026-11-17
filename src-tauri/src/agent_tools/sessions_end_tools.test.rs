use super::super::router::DENIED;
use super::super::sessions_end::tests::{host, row, FakeHost, WhileAsking};
use super::super::sessions_end::{CHILD_LIMIT, DELETE_REFUSED};
use super::*;
use crate::agent_tools::router::INVALID_INPUT;
use crate::agent_tools::sessions_send::INVALID_TARGET;

/// me -> kid -> grandkid, plus an unrelated root `other`.
fn tree() -> Vec<Session> {
    vec![
        row("me", "repo", None),
        row("kid", "repo", Some("me")),
        row("grandkid", "repo", Some("kid")),
        row("other", "repo", None),
    ]
}

async fn call(h: &Arc<FakeHost>, tool: EndTool, args: Value) -> Result<Value, ToolError> {
    run_with(h, tool, &args).await
}

fn code(result: Result<Value, ToolError>) -> String {
    result.expect_err("expected a tool error").code
}

fn set_status(h: &FakeHost, id: &str, status: &str) {
    h.statuses.lock().unwrap().insert(id.into(), status.into());
}

async fn is_archived(h: &FakeHost, id: &str) -> bool {
    let sessions = h.registry.lock().await.snapshot().sessions;
    sessions
        .iter()
        .find(|s| s.id == id)
        .unwrap()
        .archived_at
        .is_some()
}

fn card_target(h: &FakeHost) -> (String, Vec<String>) {
    let cards = h.cards.lock().unwrap();
    let crate::session::agent::PendingRequest::Approval {
        target, details, ..
    } = &cards[0]
    else {
        panic!("expected an approval card");
    };
    (target.clone(), details.clone())
}

#[tokio::test]
async fn every_tool_refuses_bad_arguments_and_unsafe_targets_before_any_card() {
    let h = Arc::new(host(tree()).await);
    for tool in EndTool::ALL {
        assert_eq!(code(call(&h, tool, json!({})).await), INVALID_INPUT);
        assert_eq!(
            code(call(&h, tool, json!({ "id": "me" })).await),
            INVALID_TARGET
        );
        assert_eq!(
            code(call(&h, tool, json!({ "id": "ghost" })).await),
            NOT_FOUND
        );
    }
    assert_eq!(h.card_count(), 0);
    assert!(h.calls().is_empty());
}

#[tokio::test]
async fn archive_asks_then_archives_only_the_target() {
    let h = Arc::new(host(tree()).await);
    let out = call(&h, EndTool::Archive, json!({ "id": "kid" }))
        .await
        .unwrap();
    assert_eq!(out, json!({ "outcome": "archived", "ids": ["kid"] }));
    assert_eq!(h.card_count(), 1);
    assert_eq!(card_target(&h).0, "Archive Session name-kid");
    assert!(is_archived(&h, "kid").await);
    assert!(!is_archived(&h, "grandkid").await);
    let sessions = h.registry.lock().await.snapshot().sessions;
    let child = sessions.iter().find(|s| s.id == "grandkid").unwrap();
    assert_eq!(child.parent_session_id.as_deref(), Some("kid"));
}

#[tokio::test]
async fn archive_in_yolo_skips_the_card() {
    let mut h = host(tree()).await;
    h.yolo = true;
    let h = Arc::new(h);
    call(&h, EndTool::Archive, json!({ "id": "kid" }))
        .await
        .unwrap();
    assert_eq!(h.card_count(), 0);
    assert!(is_archived(&h, "kid").await);
}

#[tokio::test]
async fn a_denied_archive_changes_nothing() {
    let mut h = host(tree()).await;
    h.approve = false;
    let h = Arc::new(h);
    assert_eq!(
        code(call(&h, EndTool::Archive, json!({ "id": "kid" })).await),
        DENIED
    );
    assert!(h.calls().is_empty());
    assert!(!is_archived(&h, "kid").await);
}

#[tokio::test]
async fn archive_refuses_an_archived_or_deleting_target() {
    let h = Arc::new(host(tree()).await);
    h.archive("other").await.unwrap();
    assert_eq!(
        code(call(&h, EndTool::Archive, json!({ "id": "other" })).await),
        INVALID_STATE
    );
    h.deleting.lock().unwrap().insert("kid".into());
    assert_eq!(
        code(call(&h, EndTool::Archive, json!({ "id": "kid" })).await),
        INVALID_STATE
    );
    assert_eq!(h.card_count(), 0);
}

#[tokio::test]
async fn a_cascade_is_one_card_and_archives_deepest_first() {
    let h = Arc::new(host(tree()).await);
    let args = json!({ "id": "kid", "include_children": true });
    let out = call(&h, EndTool::Archive, args).await.unwrap();
    assert_eq!(out["ids"], json!(["kid", "grandkid"]));
    assert_eq!(h.card_count(), 1);
    let (title, names) = card_target(&h);
    assert_eq!(title, "Archive 2 Sessions");
    assert_eq!(names, ["name-kid", "name-grandkid"]);
    assert_eq!(h.calls(), ["archive:grandkid", "archive:kid"]);
}

#[tokio::test]
async fn a_cascade_skips_archived_descendants_and_refuses_a_deleting_one() {
    let h = Arc::new(host(tree()).await);
    h.archive("grandkid").await.unwrap();
    let args = json!({ "id": "kid", "include_children": true });
    let out = call(&h, EndTool::Archive, args.clone()).await.unwrap();
    assert_eq!(out["ids"], json!(["kid"]));

    let h = Arc::new(host(tree()).await);
    h.deleting.lock().unwrap().insert("grandkid".into());
    assert_eq!(code(call(&h, EndTool::Archive, args).await), INVALID_STATE);
    assert_eq!(h.card_count(), 0);
    assert!(!is_archived(&h, "kid").await);
}

#[tokio::test]
async fn a_descendant_added_while_the_card_is_open_cancels_the_cascade() {
    let h = host(tree()).await;
    *h.while_asking.lock().unwrap() =
        Some(WhileAsking::Add(Box::new(row("late", "repo", Some("kid")))));
    let h = Arc::new(h);
    let args = json!({ "id": "kid", "include_children": true });
    assert_eq!(code(call(&h, EndTool::Archive, args).await), CANCELLED);
    assert!(!is_archived(&h, "kid").await);
    assert!(!is_archived(&h, "grandkid").await);
}

#[tokio::test]
async fn the_caller_deleted_while_the_card_is_open_cancels_the_call() {
    for tool in [EndTool::Archive, EndTool::Stop, EndTool::Delete] {
        let h = host(tree()).await;
        *h.while_asking.lock().unwrap() = Some(WhileAsking::Remove("me".into()));
        let h = Arc::new(h);
        assert_eq!(
            code(call(&h, tool, json!({ "id": "other" })).await),
            CANCELLED,
            "{tool:?}"
        );
        assert!(!h
            .calls()
            .iter()
            .any(|c| c.starts_with("delete:") || c.starts_with("stop:")));
    }
}

#[tokio::test]
async fn unarchive_runs_the_restore_and_leaves_archived_descendants_alone() {
    let h = Arc::new(host(tree()).await);
    h.archive("kid").await.unwrap();
    h.archive("grandkid").await.unwrap();
    let out = call(&h, EndTool::Unarchive, json!({ "id": "kid" }))
        .await
        .unwrap();
    assert_eq!(out, json!({ "outcome": "unarchived", "id": "kid" }));
    assert_eq!(h.card_count(), 0, "kid is in the caller's own tree");
    assert!(!is_archived(&h, "kid").await);
    assert!(is_archived(&h, "grandkid").await);
}

#[tokio::test]
async fn unarchive_refuses_a_live_session_and_asks_outside_the_own_tree() {
    let h = Arc::new(host(tree()).await);
    assert_eq!(
        code(call(&h, EndTool::Unarchive, json!({ "id": "kid" })).await),
        INVALID_STATE
    );
    h.archive("other").await.unwrap();
    call(&h, EndTool::Unarchive, json!({ "id": "other" }))
        .await
        .unwrap();
    assert_eq!(h.card_count(), 1);
}

#[tokio::test]
async fn unarchive_through_a_full_parent_is_child_limit() {
    let mut rows = tree();
    for id in ["a", "b", "c", "d"] {
        rows.push(row(id, "repo", Some("me")));
    }
    let h = Arc::new(host(rows).await);
    h.archive("kid").await.unwrap();
    assert_eq!(
        code(call(&h, EndTool::Unarchive, json!({ "id": "kid" })).await),
        CHILD_LIMIT
    );
    assert!(is_archived(&h, "kid").await);
    h.archive("a").await.unwrap();
    call(&h, EndTool::Unarchive, json!({ "id": "kid" }))
        .await
        .unwrap();
    assert!(!is_archived(&h, "kid").await);
}

#[tokio::test]
async fn stop_asks_unless_yolo_and_refuses_a_stopped_session() {
    let h = Arc::new(host(tree()).await);
    let out = call(&h, EndTool::Stop, json!({ "id": "kid" }))
        .await
        .unwrap();
    assert_eq!(out, json!({ "outcome": "stopped", "id": "kid" }));
    assert_eq!(h.card_count(), 1);

    let mut y = host(tree()).await;
    y.yolo = true;
    let y = Arc::new(y);
    call(&y, EndTool::Stop, json!({ "id": "kid" }))
        .await
        .unwrap();
    assert_eq!(y.card_count(), 0);

    set_status(&h, "other", "stopped");
    assert_eq!(
        code(call(&h, EndTool::Stop, json!({ "id": "other" })).await),
        SESSION_NOT_RUNNING
    );
}

#[tokio::test]
async fn a_denied_stop_leaves_the_session_running() {
    let mut h = host(tree()).await;
    h.approve = false;
    let h = Arc::new(h);
    assert_eq!(
        code(call(&h, EndTool::Stop, json!({ "id": "kid" })).await),
        DENIED
    );
    assert!(h.calls().is_empty());
}

#[tokio::test]
async fn pause_and_resume_skip_the_card_inside_the_own_tree_only() {
    let h = Arc::new(host(tree()).await);
    let out = call(&h, EndTool::Pause, json!({ "id": "kid" }))
        .await
        .unwrap();
    assert_eq!(out["outcome"], "paused");
    assert_eq!(h.card_count(), 0);
    set_status(&h, "other", "paused");
    let out = call(&h, EndTool::Resume, json!({ "id": "other" }))
        .await
        .unwrap();
    assert_eq!(out["outcome"], "resumed");
    assert_eq!(h.card_count(), 1);
    assert_eq!(card_target(&h).0, "Resume Session name-other");
}

#[tokio::test]
async fn pause_and_resume_state_errors() {
    let h = Arc::new(host(tree()).await);
    set_status(&h, "kid", "stopped");
    for tool in [EndTool::Pause, EndTool::Resume] {
        assert_eq!(
            code(call(&h, tool, json!({ "id": "kid" })).await),
            SESSION_NOT_RUNNING
        );
    }
    set_status(&h, "kid", "paused");
    assert_eq!(
        code(call(&h, EndTool::Pause, json!({ "id": "kid" })).await),
        INVALID_STATE
    );
    set_status(&h, "kid", "idle");
    assert_eq!(
        code(call(&h, EndTool::Resume, json!({ "id": "kid" })).await),
        INVALID_STATE
    );
    assert!(h.calls().is_empty());
}

#[tokio::test]
async fn a_stopped_session_that_still_holds_messages_is_not_running_for_stop_pause_and_resume() {
    let h = Arc::new(host(tree()).await);
    set_status(&h, "kid", "stopped+held");
    for tool in [EndTool::Stop, EndTool::Pause, EndTool::Resume] {
        assert_eq!(
            code(call(&h, tool, json!({ "id": "kid" })).await),
            SESSION_NOT_RUNNING
        );
    }
    assert!(h.calls().is_empty());
}

#[tokio::test]
async fn a_pausing_session_is_already_paused_and_can_be_resumed() {
    let h = Arc::new(host(tree()).await);
    set_status(&h, "kid", "pausing");
    assert_eq!(
        code(call(&h, EndTool::Pause, json!({ "id": "kid" })).await),
        INVALID_STATE
    );
    assert_eq!(h.card_count(), 0);
    let out = call(&h, EndTool::Resume, json!({ "id": "kid" }))
        .await
        .unwrap();
    assert_eq!(out["outcome"], "resumed");
}

#[tokio::test]
async fn a_pause_in_yolo_outside_the_tree_needs_no_card() {
    let mut h = host(tree()).await;
    h.yolo = true;
    let h = Arc::new(h);
    call(&h, EndTool::Pause, json!({ "id": "other" }))
        .await
        .unwrap();
    assert_eq!(h.card_count(), 0);
}

#[tokio::test]
async fn a_pause_target_that_leaves_the_own_tree_unseen_is_cancelled() {
    // No card is shown for `kid` (in the tree); the move happens before the re-check.
    let h = host(tree()).await;
    let h = Arc::new(h);
    let sessions = sessions_of(&*h).await;
    let kid = sessions.iter().find(|s| s.id == "kid").unwrap();
    h.registry
        .lock()
        .await
        .update_session(
            "kid",
            crate::store::registry::SessionPatch {
                parent_session_id: Some(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let plan = plan_for(&*h, EndTool::Pause, &sessions, kid, false)
        .await
        .unwrap();
    let result = commit(
        h.clone(),
        EndTool::Pause,
        "kid".into(),
        false,
        "repo".into(),
        plan,
        false,
    )
    .await;
    assert_eq!(code(result), CANCELLED);
    assert!(h.calls().is_empty());
}

#[tokio::test]
async fn delete_always_asks_even_in_yolo_then_deletes() {
    let mut h = host(tree()).await;
    h.yolo = true;
    let h = Arc::new(h);
    let out = call(&h, EndTool::Delete, json!({ "id": "other" }))
        .await
        .unwrap();
    assert_eq!(out, json!({ "outcome": "deleting", "id": "other" }));
    assert_eq!(h.card_count(), 1);
    assert_eq!(h.calls(), ["precheck:other", "delete:other"]);
}

#[tokio::test]
async fn delete_warns_when_live_children_will_be_re_rooted() {
    let h = Arc::new(host(tree()).await);
    call(&h, EndTool::Delete, json!({ "id": "kid" }))
        .await
        .unwrap();
    assert_eq!(card_target(&h).1.len(), 2);
}

#[tokio::test]
async fn a_denied_delete_never_reaches_delete() {
    let mut h = host(tree()).await;
    h.approve = false;
    let h = Arc::new(h);
    assert_eq!(
        code(call(&h, EndTool::Delete, json!({ "id": "other" })).await),
        DENIED
    );
    assert_eq!(h.calls(), ["precheck:other"]);
}

#[tokio::test]
async fn a_precheck_refusal_comes_before_any_card() {
    let h = host(tree()).await;
    *h.precheck_error.lock().unwrap() = Some((DELETE_REFUSED.into(), "held".into()));
    let h = Arc::new(h);
    assert_eq!(
        code(call(&h, EndTool::Delete, json!({ "id": "other" })).await),
        DELETE_REFUSED
    );
    assert_eq!(h.card_count(), 0);
    assert_eq!(h.calls(), ["precheck:other"]);
}

#[tokio::test]
async fn a_delete_already_in_flight_is_invalid_state() {
    let h = Arc::new(host(tree()).await);
    h.deleting.lock().unwrap().insert("other".into());
    assert_eq!(
        code(call(&h, EndTool::Delete, json!({ "id": "other" })).await),
        INVALID_STATE
    );
    assert!(h.calls().is_empty());
}

#[tokio::test]
async fn every_tool_refuses_a_session_being_deleted_with_invalid_state() {
    let h = Arc::new(host(tree()).await);
    h.deleting.lock().unwrap().insert("other".into());
    for tool in EndTool::ALL {
        assert_eq!(
            code(call(&h, tool, json!({ "id": "other" })).await),
            INVALID_STATE,
            "{tool:?}"
        );
    }
    assert_eq!(h.card_count(), 0);
    assert!(h.calls().is_empty());
}
