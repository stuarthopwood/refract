// Unit tests for `pause.rs`, loaded via `#[path]`. The fixture's agent has no process, like a stopped
// Session, and its worktree is missing, so a start attempt fails with `worktree-missing`.
use super::super::pause_subagents::fixture::{fixture_with, Stub};
use crate::store::registry::SessionPatch;
use std::sync::{Arc, Mutex};

async fn stopped_paused(held: &[&str]) -> super::super::pause_subagents::fixture::Fixture {
    let fx = fixture_with(Stub {
        stopped: true,
        ..Stub::default()
    })
    .await;
    fx.agent
        .state
        .lock()
        .await
        .pause
        .hold_for_test(held.iter().map(|text| text.to_string()).collect());
    fx
}

#[tokio::test]
async fn resume_on_a_stopped_session_tries_to_start_the_agent() {
    let fx = stopped_paused(&[]).await;

    let err = fx.agent.resume().await.unwrap_err();

    assert_eq!(err.code, "worktree-missing");
    assert!(fx.agent.is_paused().await);
}

#[tokio::test]
async fn a_failed_start_keeps_the_pause_and_every_held_message() {
    let fx = stopped_paused(&["first", "second"]).await;

    let err = fx.agent.resume().await.unwrap_err();

    assert_eq!(err.code, "worktree-missing");
    assert!(fx.agent.is_paused().await);
    let held = fx.agent.state.lock().await.pause.held.clone();
    assert_eq!(held, Some(vec!["first".to_string(), "second".to_string()]));
    let persisted = fx
        .agent
        .registry
        .lock()
        .await
        .get_session(&fx.agent.session_id)
        .and_then(|s| s.paused_held.clone());
    assert_eq!(
        persisted,
        Some(vec!["first".to_string(), "second".to_string()])
    );
}

#[tokio::test]
async fn a_failed_start_can_be_retried() {
    let fx = stopped_paused(&["only"]).await;

    assert_eq!(
        fx.agent.resume().await.unwrap_err().code,
        "worktree-missing"
    );
    // A stuck `resuming` flag would make the retry a silent `paused: true` no-op.
    assert_eq!(
        fx.agent.resume().await.unwrap_err().code,
        "worktree-missing"
    );
}

#[tokio::test]
async fn resume_never_starts_an_archived_session() {
    let fx = stopped_paused(&["held"]).await;
    fx.agent
        .registry
        .lock()
        .await
        .update_session(
            &fx.agent.session_id,
            SessionPatch {
                archived_at: Some(Some("2026-11-12T00:00:00.000Z".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();

    let err = fx.agent.resume().await.unwrap_err();

    assert_eq!(err.code, "session-archived");
    assert!(fx.agent.is_paused().await);
    let held = fx.agent.state.lock().await.pause.held.clone();
    assert_eq!(held, Some(vec!["held".to_string()]));
}

#[tokio::test]
async fn resume_sends_the_held_messages_in_order_then_clears_the_pause() {
    let fx = fixture_with(Stub::default()).await;
    fx.agent
        .state
        .lock()
        .await
        .pause
        .hold_for_test(vec!["first".to_string(), "second".to_string()]);

    let value = fx.agent.resume().await.unwrap();

    assert_eq!(value["paused"], false);
    let sent: Vec<String> = fx
        .rpcs()
        .await
        .iter()
        .filter(|cmd| cmd["type"] == "prompt")
        .map(|cmd| cmd["message"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(sent, ["first", "second"]);
    assert!(!fx.agent.is_paused().await);
    fx.finish().await;
}

async fn paused_live(fx: &super::super::pause_subagents::fixture::Fixture) {
    fx.agent.state.lock().await.pause.hold_for_test(Vec::new());
    fx.agent.persist_pause().await;
}

#[tokio::test]
async fn resume_all_counts_resumed_and_failed_and_leaves_archived_sessions_alone() {
    let fx = fixture_with(Stub::default()).await;
    paused_live(&fx).await;
    fx.add_session("failing", &["kept"], false).await;
    // After the failing one, so stopping at the first failure would leave it paused.
    fx.add_live_session("later").await;
    fx.add_session("archived", &["held"], true).await;

    let (resumed, failed) = super::resume_all(fx.agent.registry(), &fx.manager).await;

    assert_eq!((resumed, failed), (2, 1));
    assert!(!fx.manager.get_or_create_agent("later").is_paused().await);
    fx.stop_live_session("later").await;
    let registry = fx.agent.registry().lock().await;
    let archived = registry.get_session("archived").unwrap();
    assert_eq!(archived.paused_held, Some(vec!["held".to_string()]));
    let failing = registry.get_session("failing").unwrap();
    assert_eq!(failing.paused_held, Some(vec!["kept".to_string()]));
    drop(registry);
    assert!(fx.manager.get_or_create_agent("archived").is_paused().await);
    fx.finish().await;
}

#[tokio::test]
async fn resume_all_does_not_count_a_resume_already_in_flight() {
    let fx = fixture_with(Stub::default()).await;
    paused_live(&fx).await;
    fx.agent.state.lock().await.pause.mark_resuming_for_test();

    let (resumed, failed) = super::resume_all(fx.agent.registry(), &fx.manager).await;

    assert_eq!((resumed, failed), (0, 0));
    assert!(fx.agent.is_paused().await);
    fx.finish().await;
}

#[tokio::test]
async fn a_status_event_is_emitted_while_the_state_lock_is_held() {
    let fx = fixture_with(Stub::default()).await;
    let locked_at_emit = Arc::new(Mutex::new(Vec::new()));
    let (agent, seen) = (fx.agent.clone(), locked_at_emit.clone());
    // Only a lock held across the emit keeps a newer pause change from being delivered before it.
    fx.agent
        .events
        .set_status_probe(move || seen.lock().unwrap().push(agent.state.try_lock().is_err()));

    fx.agent.emit_status().await;

    // Stopped before the assert, so a failing run reports instead of hanging on the stub process.
    fx.finish().await;
    assert_eq!(*locked_at_emit.lock().unwrap(), [true]);
}
