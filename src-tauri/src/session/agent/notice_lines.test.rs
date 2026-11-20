// The notice slot is a list: handoff failures append, a refused send restores, a relaunch clears.

use crate::session::agent::pause_subagents::fixture::{fixture_with, Stub};

#[tokio::test]
async fn notice_lines_append_in_order() {
    let fx = fixture_with(Stub::default()).await;

    fx.agent.tell_agent_why("first".to_string()).await;
    fx.agent.tell_agent_why("second".to_string()).await;

    assert_eq!(
        fx.agent.state.lock().await.pending_agent_notice,
        ["first", "second"]
    );
    fx.agent.send("hello".to_string(), None).await.unwrap();
    let prompt = fx.rpcs().await.last().unwrap()["message"].clone();
    assert_eq!(prompt, "[Refract] first\n[Refract] second\n\nhello");
    fx.finish().await;
}

#[tokio::test]
async fn refused_send_restores_lines_at_front() {
    let fx = fixture_with(Stub {
        gated: Some("prompt"),
        fail_once: Some("prompt"),
        ..Stub::default()
    })
    .await;
    fx.agent.state.lock().await.pending_agent_notice = vec!["old one".into(), "old two".into()];

    let agent = fx.agent.clone();
    let send = tokio::spawn(async move { agent.send("hi".to_string(), None).await });
    // The send has taken the lines once the slot is empty; a line queued now is newer.
    for _ in 0..200 {
        if fx.agent.state.lock().await.pending_agent_notice.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    fx.agent.tell_agent_why("newer".to_string()).await;
    fx.release().await;

    assert!(send.await.unwrap().is_err());
    assert_eq!(
        fx.agent.state.lock().await.pending_agent_notice,
        ["old one", "old two", "newer"]
    );
    fx.finish().await;
}

#[tokio::test]
async fn relaunch_clears_all_lines() {
    let fx = fixture_with(Stub {
        stopped: true,
        ..Stub::default()
    })
    .await;
    let worktree = fx
        .agent
        .registry
        .lock()
        .await
        .get_session(&fx.agent.session_id)
        .and_then(|s| s.worktree_path.clone())
        .unwrap();
    tokio::fs::create_dir_all(&worktree).await.unwrap();
    fx.agent.state.lock().await.pending_agent_notice = vec!["one".into(), "two".into()];

    // The launch itself may or may not succeed here; only the reset is under test.
    let _ = fx.agent.start_with_conversation(None).await;

    assert!(fx.agent.state.lock().await.pending_agent_notice.is_empty());
    fx.finish().await;
}
