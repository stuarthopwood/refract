// A "complete this step" turn: sent, started by the agent's own message, settled at turn end.

use serde_json::{json, Value};

use crate::agent_tools::checklist_envelope::wrap;
use crate::checklist::model::{ChecklistFile, ItemStatus, SendAction};
use crate::checklist::records::accept_complete;
use crate::checklist::store::LiveSession;
use crate::checklist::test_support::{checklist, item};
use crate::session::agent::pause_subagents::fixture::{fixture_with, Fixture, Stub};

fn user_frame(text: &str) -> Value {
    json!({
        "type": "message_start",
        "messageId": "m1",
        "message": { "role": "user", "content": [{ "type": "text", "text": text }], "timestamp": 1 },
    })
}

/// Seeds an accepted "complete" send and returns the turn text it recorded.
async fn accept(fx: &Fixture) -> String {
    let live = LiveSession::check(&fx.agent.session_id, |_| true, |_| false).unwrap();
    fx.manager
        .checklists()
        .apply(&live, |file| {
            file.active = Some(checklist(vec![item("i1")]));
            let (_, text) = accept_complete(file, "i1", |rev| {
                wrap("p1", "i1", rev, SendAction::Complete, "body")
            })
            .unwrap();
            Ok(text)
        })
        .await
        .unwrap()
}

async fn file(fx: &Fixture) -> ChecklistFile {
    let live = LiveSession::check(&fx.agent.session_id, |_| true, |_| false).unwrap();
    fx.manager
        .checklists()
        .apply(&live, |file| Ok(file.clone()))
        .await
        .unwrap()
}

fn status(file: &ChecklistFile) -> ItemStatus {
    file.active.as_ref().unwrap().items[0].status
}

#[tokio::test]
async fn a_started_turn_restores_the_item_when_it_settles() {
    let fx = fixture_with(Stub::default()).await;
    let text = accept(&fx).await;

    fx.agent.start_from_frame(&user_frame(&text)).await;
    assert!(file(&fx).await.pending_complete[0].started);
    fx.agent.settle_checklist_turn().await;

    let after = file(&fx).await;
    assert_eq!(status(&after), ItemStatus::Upcoming);
    assert!(after.pending_complete.is_empty());
    fx.finish().await;
}

#[tokio::test]
async fn an_edited_turn_starts_nothing() {
    let fx = fixture_with(Stub::default()).await;
    let text = accept(&fx).await;

    fx.agent
        .start_from_frame(&user_frame(&format!("{text} edited")))
        .await;

    assert!(!file(&fx).await.pending_complete[0].started);
    fx.finish().await;
}

#[tokio::test]
async fn a_settle_leaves_an_unstarted_entry_waiting() {
    let fx = fixture_with(Stub::default()).await;
    accept(&fx).await;

    fx.agent.settle_checklist_turn().await;

    let after = file(&fx).await;
    assert_eq!(status(&after), ItemStatus::InProgress);
    assert_eq!(after.pending_complete.len(), 1);
    fx.finish().await;
}

#[tokio::test]
async fn withdrawing_the_queue_settles_unstarted_entries() {
    let fx = fixture_with(Stub::default()).await;
    accept(&fx).await;

    fx.agent.settle_checklist_unstarted().await;

    assert_eq!(status(&file(&fx).await), ItemStatus::Upcoming);
    fx.finish().await;
}

#[tokio::test]
async fn a_relaunch_settles_every_entry() {
    let fx = fixture_with(Stub::default()).await;
    let text = accept(&fx).await;
    fx.agent.start_from_frame(&user_frame(&text)).await;

    fx.agent.settle_checklist_all().await;

    let after = file(&fx).await;
    assert_eq!(status(&after), ItemStatus::Upcoming);
    assert!(after.pending_complete.is_empty());
    fx.finish().await;
}
