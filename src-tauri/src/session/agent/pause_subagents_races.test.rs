// Resume racing Pause's RPCs and a subagent that starts as Resume lands. Each test holds one stub
// answer, lets Resume land, then releases it, so the interleaving is fixed rather than timed.
use std::time::Duration;

use super::fixture::{fixture, fixture_with, lifecycle, Stub};

/// Long enough for a task that should do nothing to have shown it did.
const SETTLE: Duration = Duration::from_millis(300);

#[tokio::test]
async fn a_resume_during_the_listing_cancels_nothing_and_notes_nothing() {
    let fx = fixture_with(Stub {
        running: &["alpha"],
        gated: Some("get_subagents"),
        ..Stub::default()
    })
    .await;
    let pausing = fx.pause_in_background();
    fx.until_rpc("get_subagents").await;

    fx.agent.resume().await.unwrap();
    fx.release().await;
    pausing.await.unwrap().unwrap();

    assert_eq!(fx.rpc_types().await, ["get_subagents"]);
    assert!(fx.cancelled().await.is_empty());
    assert!(fx.notices().await.is_empty());
    assert!(!fx.agent.is_paused().await);
    fx.finish().await;
}

#[tokio::test]
async fn a_resume_during_a_failed_listing_posts_no_pause_notice() {
    let fx = fixture_with(Stub {
        list_error: Some("boom"),
        gated: Some("get_subagents"),
        ..Stub::default()
    })
    .await;
    let pausing = fx.pause_in_background();
    fx.until_rpc("get_subagents").await;

    fx.agent.resume().await.unwrap();
    fx.release().await;
    pausing.await.unwrap().unwrap();

    assert!(fx.notices().await.is_empty());
    fx.finish().await;
}

#[tokio::test]
async fn a_resume_during_the_cancels_leaves_no_stale_ids_and_no_notice() {
    let fx = fixture_with(Stub {
        running: &["alpha", "bravo"],
        cancel_errors: &[("bravo", "boom")],
        gated: Some("cancel_subagent"),
        ..Stub::default()
    })
    .await;
    let pausing = fx.pause_in_background();
    fx.until_rpc("cancel_subagent").await;

    fx.agent.resume().await.unwrap();
    fx.release().await;
    pausing.await.unwrap().unwrap();

    assert!(
        fx.cancelled().await.is_empty(),
        "a later Resume would name ids it never cancelled"
    );
    assert!(
        fx.notices().await.is_empty(),
        "a Pause notice after Resume reads as current"
    );
    assert!(!fx.agent.is_paused().await);
    fx.finish().await;
}

#[tokio::test]
async fn a_resume_during_an_auto_cancel_still_notes_the_cancel_but_records_no_id() {
    let fx = fixture_with(Stub {
        gated: Some("cancel_subagent"),
        ..Stub::default()
    })
    .await;
    fx.agent.pause().await.unwrap();
    fx.agent.handle_frame(lifecycle("late-1", "started")).await;
    fx.until_rpc("cancel_subagent").await;

    fx.agent.resume().await.unwrap();
    fx.release().await;
    fx.until_notices(1).await;
    tokio::time::sleep(SETTLE).await;

    assert!(
        fx.cancelled().await.is_empty(),
        "Resume already consumed the list; a stale id would leak into the next Resume"
    );
    assert_eq!(
        fx.notices().await,
        ["Pause cancelled subagent late-1, which started as this Session was resumed. It is not restarted."]
    );
    fx.finish().await;
}

#[tokio::test]
async fn a_resume_during_a_failed_auto_cancel_posts_no_notice() {
    let fx = fixture_with(Stub {
        cancel_errors: &[("late-1", "boom")],
        gated: Some("cancel_subagent"),
        ..Stub::default()
    })
    .await;
    fx.agent.pause().await.unwrap();
    fx.agent.handle_frame(lifecycle("late-1", "started")).await;
    fx.until_rpc("cancel_subagent").await;

    fx.agent.resume().await.unwrap();
    fx.release().await;
    tokio::time::sleep(SETTLE).await;

    assert!(fx.notices().await.is_empty());
    fx.finish().await;
}

#[tokio::test]
async fn an_auto_cancel_that_starts_after_resume_sends_nothing() {
    let fx = fixture(&[], &[]).await;
    fx.agent.pause().await.unwrap();
    fx.agent.resume().await.unwrap();
    let before = fx.rpcs().await.len();

    fx.agent.auto_cancel("late-1").await;

    assert_eq!(fx.rpcs().await.len(), before);
    assert!(fx.cancelled().await.is_empty());
    assert!(fx.notices().await.is_empty());
    fx.finish().await;
}

#[tokio::test]
async fn a_subagent_started_after_resume_is_left_running() {
    let fx = fixture(&[], &[]).await;
    fx.agent.pause().await.unwrap();
    fx.agent.resume().await.unwrap();
    let before = fx.rpcs().await.len();

    fx.agent.handle_frame(lifecycle("late-1", "started")).await;
    tokio::time::sleep(SETTLE).await;

    assert_eq!(fx.rpcs().await.len(), before);
    assert!(fx.cancelled().await.is_empty());
    fx.finish().await;
}
