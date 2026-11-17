// The handoff-note flag: default, and that every frame keeps the label on the first user message.

use serde_json::json;

use super::{mark_note, State};
use crate::omp::diff::{diff_transcript, TranscriptOp};
use crate::omp::transcript::{MessageSource, TranscriptItem};
use crate::session::agent::pause_subagents::fixture::fixture;

fn user_frame(kind: &str) -> serde_json::Value {
    json!({
        "type": kind,
        "messageId": "m1",
        "message": { "role": "user", "content": [{ "type": "text", "text": "hi" }], "timestamp": 1 },
    })
}

fn first_user_source(items: &[std::sync::Arc<TranscriptItem>]) -> Option<MessageSource> {
    items.iter().find_map(|item| match &**item {
        TranscriptItem::User { source, .. } => source.clone(),
        _ => None,
    })
}

#[test]
fn the_flag_defaults_to_false() {
    assert!(!State::default().note_live);
}

#[tokio::test]
async fn mark_note_changes_nothing_while_the_flag_is_false() {
    let fx = fixture(&[], &[]).await;
    let mut state = fx.agent.state.lock().await;
    state
        .transcript
        .apply_frame(&user_frame("message_end"), false);
    let before = state.transcript.snapshot();

    mark_note(&mut state);

    assert!(first_user_source(state.transcript.items()).is_none());
    assert!(diff_transcript(&before, state.transcript.items()).is_empty());
    drop(state);
    fx.finish().await;
}

#[tokio::test]
async fn every_frame_keeps_the_label_and_the_diff_carries_it() {
    let fx = fixture(&[], &[]).await;
    let mut state = fx.agent.state.lock().await;
    state.handoff.note_live = true;

    fx.agent
        .apply_frame_locked(&mut state, &user_frame("message_start"));
    assert_eq!(
        first_user_source(state.transcript.items()),
        Some(MessageSource::Handoff)
    );

    let before = state.transcript.snapshot();
    fx.agent
        .apply_frame_locked(&mut state, &user_frame("message_end"));
    assert_eq!(
        first_user_source(state.transcript.items()),
        Some(MessageSource::Handoff)
    );
    let ops = diff_transcript(&before, state.transcript.items());
    assert!(ops.iter().any(|op| matches!(
        op,
        TranscriptOp::Upsert { item }
            if matches!(**item, TranscriptItem::User { source: Some(MessageSource::Handoff), .. })
    )));
    drop(state);
    fx.finish().await;
}

#[tokio::test]
async fn a_frame_leaves_the_message_unlabelled_while_the_flag_is_false() {
    let fx = fixture(&[], &[]).await;
    let mut state = fx.agent.state.lock().await;

    fx.agent
        .apply_frame_locked(&mut state, &user_frame("message_start"));
    fx.agent
        .apply_frame_locked(&mut state, &user_frame("message_end"));

    assert!(first_user_source(state.transcript.items()).is_none());
    drop(state);
    fx.finish().await;
}
