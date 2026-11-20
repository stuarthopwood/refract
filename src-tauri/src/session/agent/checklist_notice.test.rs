// The checklist line rides on the user's next prompt, after any handoff line.

use serde_json::json;

use crate::checklist::developer_ops::apply_developer;
use crate::checklist::model::Checklist;
use crate::checklist::store::LiveSession;
use crate::checklist::test_support::{checklist, item, op};
use crate::session::agent::pause_subagents::fixture::{fixture_with, Fixture, Stub};

const HINT: &str = "Checklist p1 changed by the developer after rev 0: tick i1. \
                    Call refract_checklist get.";

fn ticked_by_developer(seen: bool) -> Checklist {
    let list = checklist(vec![item("i1")]);
    let mut list = apply_developer(
        &list,
        list.rev,
        &op(json!({"op": "setStatus", "id": "i1", "status": "complete"})),
    )
    .unwrap()
    .checklist;
    if seen {
        list.agent_seen_rev = list.rev;
    }
    list
}

/// Seeds the Session's checklist through the manager's own store, which lives in the fixture's temp dir.
async fn seed(fx: &Fixture, list: Checklist) {
    let live = LiveSession::check(&fx.agent.session_id, |_| true, |_| false).unwrap();
    fx.manager
        .checklists()
        .apply(&live, |file| {
            file.active = Some(list);
            Ok(())
        })
        .await
        .unwrap();
    fx.agent.state.lock().await.checklist_line_due = false;
}

async fn last_prompt(fx: &Fixture) -> String {
    let rpcs = fx.rpcs().await;
    rpcs.iter()
        .rev()
        .find(|cmd| cmd["type"] == "prompt")
        .unwrap()["message"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn checklist_hint_added_when_agent_behind() {
    let fx = fixture_with(Stub::default()).await;
    seed(&fx, ticked_by_developer(false)).await;

    fx.agent.send("hello".to_string(), None).await.unwrap();

    assert_eq!(last_prompt(&fx).await, format!("[Refract] {HINT}\n\nhello"));
    fx.finish().await;
}

#[tokio::test]
async fn no_hint_when_seen() {
    let fx = fixture_with(Stub::default()).await;
    seed(&fx, ticked_by_developer(true)).await;

    fx.agent.send("hello".to_string(), None).await.unwrap();

    assert_eq!(last_prompt(&fx).await, "hello");
    fx.finish().await;
}

#[tokio::test]
async fn hint_line_appended_after_handoff_line() {
    let fx = fixture_with(Stub::default()).await;
    seed(&fx, ticked_by_developer(false)).await;
    fx.agent.state.lock().await.pending_agent_notice = vec!["Handoff failed: boom".to_string()];

    fx.agent.send("hello".to_string(), None).await.unwrap();

    assert_eq!(
        last_prompt(&fx).await,
        format!("[Refract] Handoff failed: boom\n[Refract] {HINT}\n\nhello")
    );
    fx.finish().await;
}

#[tokio::test]
async fn a_new_conversation_hears_the_checklist_once() {
    let fx = fixture_with(Stub::default()).await;
    seed(&fx, ticked_by_developer(true)).await;
    fx.agent.state.lock().await.checklist_line_due = true;

    fx.agent.send("one".to_string(), None).await.unwrap();
    let first = last_prompt(&fx).await;
    fx.agent.send("two".to_string(), None).await.unwrap();

    assert!(
        first.starts_with("[Refract] Checklist p1 is active: rev"),
        "{first}"
    );
    assert!(first.contains("1 of 1 items complete."), "{first}");
    assert_eq!(last_prompt(&fx).await, "two");
    fx.finish().await;
}

#[tokio::test]
async fn a_relaunch_hears_the_checklist_again() {
    let fx = fixture_with(Stub {
        stopped: true,
        ..Stub::default()
    })
    .await;
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
    fx.agent.state.lock().await.checklist_line_due = false;

    // The launch itself may or may not succeed here; only the re-arm is under test.
    let _ = fx.agent.launch(&session, worktree, false, "").await;

    assert!(fx.agent.state.lock().await.checklist_line_due);
    fx.finish().await;
}
