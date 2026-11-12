// Unit tests for `pause.rs`, loaded via `#[path]`. The fixture's agent has no process, like a stopped
// Session, and its worktree is missing, so a start attempt fails with `worktree-missing`.
use super::super::pause_subagents::fixture::{fixture_with, Stub};
use crate::store::registry::SessionPatch;

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
}
