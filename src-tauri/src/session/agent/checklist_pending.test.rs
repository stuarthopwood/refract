// A "complete this step" turn: sent, started by the agent's own message, settled at turn end.

use serde_json::{json, Value};

use crate::agent_tools::checklist_envelope::wrap;
use crate::agent_tools::envelope;
use crate::checklist::model::{ChecklistFile, ItemStatus, SendAction, MAX_SEND_RECORDS};
use crate::checklist::records::{accept_complete, add_send_record};
use crate::checklist::store::LiveSession;
use crate::checklist::test_support::{checklist, item};
use crate::session::agent::pause_subagents::fixture::{fixture_with, Fixture, Stub};
use crate::session::agent::SessionStatus;

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
async fn own_turn_starts_the_entry() {
    let fx = fixture_with(Stub::default()).await;
    let text = accept(&fx).await;

    fx.agent.start_from_frame(&user_frame(&text)).await;

    assert!(file(&fx).await.pending_complete[0].started);
    fx.finish().await;
}

#[tokio::test]
async fn edited_text_does_not_start_it() {
    let fx = fixture_with(Stub::default()).await;
    let text = accept(&fx).await;

    fx.agent
        .start_from_frame(&user_frame(&format!("{text} edited")))
        .await;

    assert!(!file(&fx).await.pending_complete[0].started);
    fx.finish().await;
}

#[tokio::test]
async fn other_rev_does_not_start_it() {
    let fx = fixture_with(Stub::default()).await;
    accept(&fx).await;
    let other = wrap("p1", "i1", 99, SendAction::Complete, "body");

    fx.agent.start_from_frame(&user_frame(&other)).await;

    assert!(!file(&fx).await.pending_complete[0].started);
    fx.finish().await;
}

#[tokio::test]
async fn handoff_note_turn_is_skipped() {
    let fx = fixture_with(Stub::default()).await;
    let text = accept(&fx).await;
    fx.agent.state.lock().await.handoff.note_live = true;

    fx.agent.start_from_frame(&user_frame(&text)).await;

    assert!(!file(&fx).await.pending_complete[0].started);
    fx.finish().await;
}

#[tokio::test]
async fn session_message_body_is_not_parsed() {
    let fx = fixture_with(Stub::default()).await;
    let text = accept(&fx).await;
    let from_a_sibling = envelope::wrap("sibling", "s2", &text);

    fx.agent
        .start_from_frame(&user_frame(&from_a_sibling))
        .await;

    assert!(!file(&fx).await.pending_complete[0].started);
    fx.finish().await;
}

#[tokio::test]
async fn settle_started_restores_when_status_rev_equals_turn_marker() {
    let fx = fixture_with(Stub::default()).await;
    let text = accept(&fx).await;

    fx.agent.start_from_frame(&user_frame(&text)).await;
    fx.agent.settle_checklist_turn().await;

    let after = file(&fx).await;
    assert_eq!(status(&after), ItemStatus::Upcoming);
    assert!(after.pending_complete.is_empty());
    fx.finish().await;
}

#[tokio::test]
async fn settle_started_keeps_a_status_the_agent_changed() {
    let fx = fixture_with(Stub::default()).await;
    let text = accept(&fx).await;
    fx.agent.start_from_frame(&user_frame(&text)).await;
    let live = LiveSession::check(&fx.agent.session_id, |_| true, |_| false).unwrap();
    fx.manager
        .checklists()
        .apply(&live, |file| {
            let list = file.active.as_mut().unwrap();
            list.rev += 1;
            let rev = list.rev;
            list.items[0].status = ItemStatus::Blocked;
            list.items[0].status_rev = rev;
            Ok(())
        })
        .await
        .unwrap();

    fx.agent.settle_checklist_turn().await;

    assert_eq!(status(&file(&fx).await), ItemStatus::Blocked);
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
async fn stop_settles_a_queued_unstarted_complete() {
    let fx = fixture_with(Stub::default()).await;
    accept(&fx).await;
    {
        let mut state = fx.agent.state.lock().await;
        state.status = SessionStatus::Working;
        state.turn_generation = 1;
    }

    // `stop` waits for the Session to go idle, so run it aside and release it afterwards.
    let agent = fx.agent.clone();
    let stopping = tokio::spawn(async move { agent.stop().await });
    for _ in 0..200 {
        if status(&file(&fx).await) == ItemStatus::Upcoming {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    let after = file(&fx).await;
    assert_eq!(status(&after), ItemStatus::Upcoming);
    assert!(after.pending_complete.is_empty());

    fx.agent.set_status(SessionStatus::Idle, None, None).await;
    stopping.await.unwrap().unwrap();
    fx.finish().await;
}

#[tokio::test]
async fn relaunch_settles_all() {
    let fx = fixture_with(Stub::default()).await;
    let text = accept(&fx).await;
    fx.agent.start_from_frame(&user_frame(&text)).await;

    fx.agent.settle_checklist_all().await;

    let after = file(&fx).await;
    assert_eq!(status(&after), ItemStatus::Upcoming);
    assert!(after.pending_complete.is_empty());
    fx.finish().await;
}

#[tokio::test]
async fn removing_a_held_complete_restores_the_item() {
    let fx = fixture_with(Stub::default()).await;
    let text = accept(&fx).await;
    fx.agent
        .state
        .lock()
        .await
        .pause
        .hold_for_test(vec![text.clone()]);

    let out = fx.agent.remove_queued(text, "followUp").await.unwrap();

    assert_eq!(out["removed"], true);
    let after = file(&fx).await;
    assert_eq!(status(&after), ItemStatus::Upcoming);
    assert!(after.pending_complete.is_empty());
    fx.finish().await;
}

async fn prompts(fx: &Fixture) -> Vec<String> {
    fx.rpcs()
        .await
        .iter()
        .filter(|cmd| cmd["type"] == "prompt")
        .map(|cmd| cmd["message"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn a_held_envelope_resumes_verbatim_and_undecorated() {
    let fx = fixture_with(Stub::default()).await;
    let text = accept(&fx).await;
    {
        let mut state = fx.agent.state.lock().await;
        state.pause.hold_for_test(vec![text.clone()]);
        state.pending_agent_notice = vec!["Handoff failed: boom".to_string()];
        state.checklist_line_due = true;
    }

    fx.agent.resume().await.unwrap();

    assert_eq!(prompts(&fx).await, std::slice::from_ref(&text));
    let state = fx.agent.state.lock().await;
    assert_eq!(state.pending_agent_notice, ["Handoff failed: boom"]);
    assert!(state.checklist_line_due);
    drop(state);
    fx.agent.start_from_frame(&user_frame(&text)).await;
    assert!(file(&fx).await.pending_complete[0].started);
    fx.finish().await;
}

#[tokio::test]
async fn stop_while_held_does_not_restore_the_held_item() {
    let fx = fixture_with(Stub::default()).await;
    let text = accept(&fx).await;
    fx.agent.state.lock().await.pause.hold_for_test(vec![text]);

    fx.agent.settle_checklist_unstarted().await;
    fx.agent.settle_checklist_all().await;

    let after = file(&fx).await;
    assert_eq!(status(&after), ItemStatus::InProgress);
    assert_eq!(after.pending_complete.len(), 1);
    fx.finish().await;
}

#[tokio::test]
async fn evicted_send_record_never_starts_and_settle_restores() {
    let fx = fixture_with(Stub::default()).await;
    let text = accept(&fx).await;
    let live = LiveSession::check(&fx.agent.session_id, |_| true, |_| false).unwrap();
    fx.manager
        .checklists()
        .apply(&live, |file| {
            for n in 0..MAX_SEND_RECORDS {
                add_send_record(file, "p1", "i1", 1, SendAction::Ask, &format!("ask {n}"));
            }
            Ok(())
        })
        .await
        .unwrap();

    fx.agent.start_from_frame(&user_frame(&text)).await;
    assert!(!file(&fx).await.pending_complete[0].started);
    fx.agent.settle_checklist_turn().await;

    let after = file(&fx).await;
    assert_eq!(status(&after), ItemStatus::Upcoming);
    assert!(after.pending_complete.is_empty());
    fx.finish().await;
}

#[tokio::test]
async fn frames_start_then_settle_the_entry() {
    let fx = fixture_with(Stub::default()).await;
    let text = accept(&fx).await;

    fx.agent
        .handle_frame(json!({ "type": "agent_start" }))
        .await;
    fx.agent.handle_frame(user_frame(&text)).await;
    assert!(file(&fx).await.pending_complete[0].started);
    fx.agent
        .handle_frame(json!({ "type": "session_settled" }))
        .await;

    let after = file(&fx).await;
    assert_eq!(status(&after), ItemStatus::Upcoming);
    assert!(after.pending_complete.is_empty());
    fx.finish().await;
}

#[tokio::test]
async fn launch_settles_an_entry_left_by_the_last_life() {
    let fx = fixture_with(Stub {
        stopped: true,
        ..Stub::default()
    })
    .await;
    let text = accept(&fx).await;
    fx.agent.start_from_frame(&user_frame(&text)).await;
    let session = fx
        .agent
        .registry
        .lock()
        .await
        .get_session(&fx.agent.session_id)
        .cloned()
        .unwrap();
    let worktree = std::path::PathBuf::from(session.worktree_path.clone().unwrap());
    tokio::fs::create_dir_all(&worktree).await.unwrap();

    // The launch itself may or may not succeed here; only the settle is under test.
    let _ = fx.agent.launch(&session, worktree, false, "").await;

    let after = file(&fx).await;
    assert_eq!(status(&after), ItemStatus::Upcoming);
    assert!(after.pending_complete.is_empty());
    fx.finish().await;
}
