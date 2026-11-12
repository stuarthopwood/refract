// Unit tests for `pause_subagents.rs`, loaded via `#[path]`. The stub OMP lives in `fixture`.
use std::time::Duration;

use serde_json::json;

use super::fixture::{fixture, fixture_with, lifecycle, Stub};
use super::{classify, listed_ids, rpc_error, Outcome};
use crate::session::agent::pause::State;

#[test]
fn classify_reads_a_successful_cancel() {
    let cancelled = json!({ "success": true, "data": { "cancelled": true } });
    let settled = json!({ "success": true, "data": { "cancelled": false } });
    let bare = json!({ "success": true });

    assert_eq!(classify(&cancelled), Outcome::Cancelled);
    assert_eq!(classify(&settled), Outcome::NothingToCancel);
    assert_eq!(classify(&bare), Outcome::NothingToCancel);
}

#[test]
fn classify_treats_not_running_as_nothing_to_cancel() {
    let response = json!({ "success": false, "error": "Subagent alpha is not running" });

    assert_eq!(classify(&response), Outcome::NothingToCancel);
}

#[test]
fn classify_fails_on_any_other_rejection() {
    let named = json!({ "success": false, "error": "boom" });
    let unnamed = json!({ "success": false });

    assert_eq!(classify(&named), Outcome::Failed("boom".to_string()));
    assert_eq!(
        classify(&unnamed),
        Outcome::Failed("unknown error".to_string())
    );
}

#[test]
fn rpc_error_names_the_error_or_falls_back() {
    assert_eq!(rpc_error(&json!({ "error": "boom" })), "boom");
    assert_eq!(rpc_error(&json!({ "error": 7 })), "unknown error");
    assert_eq!(rpc_error(&json!({})), "unknown error");
}

#[test]
fn listed_ids_keeps_every_entry_that_has_an_id() {
    let response = json!({
        "success": true,
        "data": { "subagents": [{ "id": "alpha" }, { "name": "no id" }, { "id": "bravo" }] }
    });

    assert_eq!(
        listed_ids(&response),
        Ok(vec!["alpha".into(), "bravo".into()])
    );
}

#[test]
fn listed_ids_is_empty_when_the_data_has_no_list() {
    assert_eq!(listed_ids(&json!({ "success": true })), Ok(Vec::new()));
    assert_eq!(
        listed_ids(&json!({ "success": true, "data": { "subagents": "none" } })),
        Ok(Vec::new())
    );
}

#[test]
fn listed_ids_returns_the_rpc_error_on_failure() {
    assert_eq!(
        listed_ids(&json!({ "success": false, "error": "boom" })),
        Err("boom".to_string())
    );
    assert_eq!(
        listed_ids(&json!({ "success": false })),
        Err("unknown error".to_string())
    );
}

#[test]
fn a_session_gates_only_while_held_and_not_resuming() {
    let mut state = State::default();
    assert!(!state.is_gating(), "a Session that never paused");

    state.hold_for_test(Vec::new());
    assert!(state.is_gating(), "paused");

    state.mark_resuming_for_test();
    assert!(!state.is_gating(), "a resume drain is running");
}

#[tokio::test]
async fn pause_lists_then_cancels_every_running_subagent() {
    let fx = fixture(&["alpha", "bravo"], &[]).await;

    fx.agent.pause().await.unwrap();

    let types = fx.rpc_types().await;
    assert_eq!(types[0], "get_subagents");
    assert_eq!(types.len(), 3);
    assert_eq!(fx.cancel_targets().await, ["alpha", "bravo"]);
    assert_eq!(fx.cancelled().await, ["alpha", "bravo"]);
    assert_eq!(
        fx.notices().await,
        ["Pause cancelled 2 subagents: alpha, bravo."]
    );
    fx.finish().await;
}

#[tokio::test]
async fn pause_without_subagents_sends_only_the_listing() {
    let fx = fixture(&[], &[]).await;

    fx.agent.pause().await.unwrap();

    assert_eq!(fx.rpc_types().await, ["get_subagents"]);
    assert!(fx.cancelled().await.is_empty());
    assert!(fx.notices().await.is_empty());
    fx.finish().await;
}

#[tokio::test]
async fn a_subagent_that_answers_cancelled_false_is_not_recorded() {
    let fx = fixture(&["alpha", "bravo"], &["bravo"]).await;

    fx.agent.pause().await.unwrap();

    assert_eq!(fx.cancel_targets().await, ["alpha", "bravo"]);
    assert_eq!(fx.cancelled().await, ["alpha"]);
    assert_eq!(fx.notices().await, ["Pause cancelled 1 subagent: alpha."]);
    fx.finish().await;
}

#[tokio::test]
async fn a_failed_listing_is_noted_and_cancels_nothing_but_the_session_still_pauses() {
    let fx = fixture_with(Stub {
        running: &["alpha"],
        list_error: Some("boom"),
        ..Stub::default()
    })
    .await;

    fx.agent.pause().await.unwrap();

    assert_eq!(fx.rpc_types().await, ["get_subagents"]);
    assert!(fx.cancelled().await.is_empty());
    assert_eq!(
        fx.notices().await,
        ["Pause could not list the running subagents: boom"]
    );
    assert!(fx.agent.is_paused().await);
    fx.finish().await;
}

#[tokio::test]
async fn a_cancel_that_fails_is_noted_and_not_recorded() {
    let fx = fixture_with(Stub {
        running: &["alpha", "bravo"],
        cancel_errors: &[("bravo", "boom")],
        ..Stub::default()
    })
    .await;

    fx.agent.pause().await.unwrap();

    assert_eq!(fx.cancel_targets().await, ["alpha", "bravo"]);
    assert_eq!(fx.cancelled().await, ["alpha"]);
    assert_eq!(
        fx.notices().await,
        [
            "Pause cancelled 1 subagent: alpha.",
            "Pause could not cancel 1 subagent: bravo (boom)."
        ]
    );
    fx.finish().await;
}

#[tokio::test]
async fn a_cancel_answering_not_running_is_neither_recorded_nor_reported() {
    let fx = fixture_with(Stub {
        running: &["alpha"],
        cancel_errors: &[("alpha", "Subagent alpha is not running")],
        ..Stub::default()
    })
    .await;

    fx.agent.pause().await.unwrap();

    assert_eq!(fx.cancel_targets().await, ["alpha"]);
    assert!(fx.cancelled().await.is_empty());
    assert!(fx.notices().await.is_empty());
    fx.finish().await;
}

#[tokio::test]
async fn a_second_pause_does_not_cancel_again() {
    let fx = fixture(&["alpha"], &[]).await;

    fx.agent.pause().await.unwrap();
    fx.agent.pause().await.unwrap();

    assert_eq!(fx.rpc_types().await, ["get_subagents", "cancel_subagent"]);
    fx.finish().await;
}

#[tokio::test]
async fn a_subagent_started_while_paused_is_cancelled_and_noted() {
    let fx = fixture(&[], &[]).await;
    fx.agent.pause().await.unwrap();

    fx.agent.handle_frame(lifecycle("late-1", "started")).await;
    fx.until_rpc("cancel_subagent").await;
    fx.until_notices(1).await;

    assert_eq!(fx.cancel_targets().await, ["late-1"]);
    assert_eq!(fx.cancelled().await, ["late-1"]);
    assert_eq!(
        fx.notices().await,
        ["Pause cancelled subagent late-1, which started while this Session was paused."]
    );
    fx.finish().await;
}

#[tokio::test]
async fn an_auto_cancel_that_fails_is_noted_and_not_recorded() {
    let fx = fixture_with(Stub {
        cancel_errors: &[("late-1", "boom")],
        ..Stub::default()
    })
    .await;
    fx.agent.pause().await.unwrap();

    fx.agent.handle_frame(lifecycle("late-1", "started")).await;
    fx.until_notices(1).await;

    assert!(fx.cancelled().await.is_empty());
    assert_eq!(
        fx.notices().await,
        ["Pause could not cancel subagent late-1, which started while this Session was paused: boom"]
    );
    fx.finish().await;
}

#[tokio::test]
async fn a_subagent_started_while_not_paused_is_left_running() {
    let fx = fixture(&[], &[]).await;

    fx.agent.handle_frame(lifecycle("late-1", "started")).await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    assert!(fx.rpcs().await.is_empty());
    assert!(fx.cancelled().await.is_empty());
    fx.finish().await;
}

#[tokio::test]
async fn only_the_started_status_triggers_an_auto_cancel() {
    let fx = fixture(&["busy"], &[]).await;
    fx.agent.pause().await.unwrap();
    let before = fx.rpcs().await.len();

    fx.agent.handle_frame(lifecycle("busy", "completed")).await;
    fx.agent.handle_frame(lifecycle("busy", "aborted")).await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    assert_eq!(fx.rpcs().await.len(), before);
    fx.finish().await;
}

#[tokio::test]
async fn resume_posts_one_notice_naming_the_cancelled_subagents_and_sends_nothing() {
    let fx = fixture(&["alpha", "bravo"], &[]).await;
    fx.agent.pause().await.unwrap();
    let before = fx.rpcs().await.len();

    fx.agent.resume().await.unwrap();

    assert!(fx.cancelled().await.is_empty());
    assert_eq!(
        fx.rpcs().await.len(),
        before,
        "resume must not revive anything"
    );
    let resumed: Vec<String> = fx
        .notices()
        .await
        .into_iter()
        .filter(|text| text.starts_with("Resumed."))
        .collect();
    assert_eq!(resumed.len(), 1);
    assert!(resumed[0].contains("2 subagents: alpha, bravo"));
    assert!(!fx.agent.is_paused().await);
    fx.finish().await;
}

#[tokio::test]
async fn resume_after_a_pause_that_cancelled_nothing_posts_no_notice() {
    let fx = fixture(&[], &[]).await;
    fx.agent.pause().await.unwrap();

    fx.agent.resume().await.unwrap();

    assert!(fx.notices().await.is_empty());
    fx.finish().await;
}

#[tokio::test]
async fn a_subagent_started_by_a_resume_drain_is_not_cancelled() {
    let fx = fixture(&[], &[]).await;
    fx.agent.pause().await.unwrap();
    fx.agent.state.lock().await.pause.mark_resuming_for_test();
    let before = fx.rpcs().await.len();

    fx.agent.handle_frame(lifecycle("late-1", "started")).await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    assert_eq!(fx.rpcs().await.len(), before);
    fx.finish().await;
}

#[tokio::test]
async fn a_failed_drain_keeps_the_cancelled_list_and_posts_no_notice() {
    let fx = fixture(&["alpha", "bravo"], &[]).await;
    fx.agent.pause().await.unwrap();
    fx.agent
        .state
        .lock()
        .await
        .pause
        .hold_for_test(vec!["held text".to_string()]);
    // A stopped process still counts as attached, so the drain's send fails and the Session stays paused.
    let process = fx.agent.state.lock().await.process.clone().unwrap();
    process.stop().await;

    assert!(fx.agent.resume().await.is_err());

    assert!(fx.agent.is_paused().await);
    assert_eq!(fx.cancelled().await, ["alpha", "bravo"]);
    assert!(!fx
        .notices()
        .await
        .iter()
        .any(|text| text.starts_with("Resumed.")));
    fx.finish().await;
}

#[tokio::test]
async fn a_process_exit_clears_the_cancelled_list_so_resume_posts_no_notice() {
    let fx = fixture(&["alpha"], &[]).await;
    fx.agent.pause().await.unwrap();
    assert_eq!(fx.cancelled().await, ["alpha"]);
    let process = fx.agent.state.lock().await.process.clone().unwrap();
    process.stop().await;

    fx.agent.handle_exit(&process, Some(1), false).await;

    assert!(fx.cancelled().await.is_empty());
    // Resume now starts a stopped agent; this test is about the notice, so pretend it is already up.
    fx.agent.state.lock().await.status = crate::session::agent::SessionStatus::Idle;
    fx.agent.resume().await.unwrap();
    assert!(!fx
        .notices()
        .await
        .iter()
        .any(|text| text.starts_with("Resumed.")));
    fx.finish().await;
}

#[tokio::test]
async fn a_conversation_reset_clears_the_cancelled_list_so_resume_posts_no_notice() {
    let fx = fixture(&["alpha"], &[]).await;
    fx.agent.pause().await.unwrap();
    assert_eq!(fx.cancelled().await, ["alpha"]);
    fx.agent.state.lock().await.status = crate::session::agent::SessionStatus::Idle;

    fx.agent.start_new_conversation().await.unwrap();

    assert!(fx.cancelled().await.is_empty());
    fx.agent.resume().await.unwrap();
    assert!(!fx
        .notices()
        .await
        .iter()
        .any(|text| text.starts_with("Resumed.")));
    fx.finish().await;
}
