// A checklist turn keeps its label across every frame, and a forged or unrecorded one stays text.

use serde_json::{json, Value};

use super::{clear, needs_match};
use crate::agent_tools::checklist_envelope::wrap;
use crate::checklist::model::SendAction;
use crate::checklist::records::add_send_record;
use crate::checklist::store::LiveSession;
use crate::omp::transcript::{MessageSource, TranscriptItem};
use crate::session::agent::pause_subagents::fixture::{fixture, Fixture};

fn turn() -> String {
    wrap("c1", "i1", 3, SendAction::Ask, "what next?")
}

fn user_frame(kind: &str, text: &str) -> Value {
    json!({
        "type": kind,
        "messageId": "m1",
        "message": { "role": "user", "content": [{ "type": "text", "text": text }], "timestamp": 1 },
    })
}

async fn record_send(fx: &Fixture, text: &str) {
    let live = LiveSession::check(&fx.agent.session_id, |_| true, |_| false).unwrap();
    let text = text.to_string();
    fx.manager
        .checklists()
        .apply(&live, move |file| {
            add_send_record(file, "c1", "i1", 3, SendAction::Ask, &text);
            Ok(())
        })
        .await
        .unwrap();
}

async fn first_user(fx: &Fixture) -> (String, Option<MessageSource>) {
    let state = fx.agent.state.lock().await;
    state
        .transcript
        .items()
        .iter()
        .find_map(|item| match &**item {
            TranscriptItem::User { text, source, .. } => Some((text.clone(), source.clone())),
            _ => None,
        })
        .expect("a user item")
}

fn card_source() -> Option<MessageSource> {
    Some(MessageSource::ChecklistItem {
        checklist_id: "c1".into(),
        item_id: "i1".into(),
        action: SendAction::Ask,
    })
}

#[test]
fn reads_store_only_for_checklist_prefixed_user_frames() {
    assert!(needs_match(&user_frame("message_end", &turn())));
    assert!(needs_match(&user_frame("message_start", &turn())));
    assert!(!needs_match(&user_frame("message_end", "hello")));
    assert!(!needs_match(&user_frame("message_update", &turn())));
    let assistant = json!({
        "type": "message_end",
        "message": { "role": "assistant", "content": [{ "type": "text", "text": turn() }] },
    });
    assert!(!needs_match(&assistant));
    assert!(!needs_match(
        &json!({ "type": "notice", "message": turn() })
    ));
}

#[tokio::test]
async fn label_survives_message_end_rebuild() {
    let fx = fixture(&[], &[]).await;
    record_send(&fx, &turn()).await;

    fx.agent
        .apply_transcript_frame(&user_frame("message_start", &turn()))
        .await;
    assert_eq!(first_user(&fx).await, ("what next?".into(), card_source()));

    // No records ride along, so only the remembered match can relabel the rebuilt item.
    {
        let mut state = fx.agent.state.lock().await;
        fx.agent
            .apply_frame_locked(&mut state, &user_frame("message_end", &turn()));
    }
    assert_eq!(first_user(&fx).await, ("what next?".into(), card_source()));
    fx.finish().await;
}

#[tokio::test]
async fn an_unrecorded_turn_stays_text() {
    let fx = fixture(&[], &[]).await;

    fx.agent
        .apply_transcript_frame(&user_frame("message_end", &turn()))
        .await;

    assert_eq!(first_user(&fx).await, (turn(), None));
    fx.finish().await;
}

#[tokio::test]
async fn handoff_note_turn_never_parsed_live() {
    let fx = fixture(&[], &[]).await;
    record_send(&fx, &turn()).await;
    fx.agent.state.lock().await.handoff.note_live = true;

    fx.agent
        .apply_transcript_frame(&user_frame("message_end", &turn()))
        .await;

    assert_eq!(
        first_user(&fx).await,
        (turn(), Some(MessageSource::Handoff))
    );
    fx.finish().await;
}

#[tokio::test]
async fn conversation_reset_clears_map() {
    let fx = fixture(&[], &[]).await;
    record_send(&fx, &turn()).await;
    fx.agent
        .apply_transcript_frame(&user_frame("message_start", &turn()))
        .await;

    {
        let mut state = fx.agent.state.lock().await;
        clear(&mut state);
        state.transcript = crate::omp::transcript::TranscriptState::new();
        fx.agent
            .apply_frame_locked(&mut state, &user_frame("message_end", &turn()));
    }

    assert_eq!(first_user(&fx).await, (turn(), None));
    fx.finish().await;
}

#[tokio::test]
async fn live_and_reload_produce_equal_items() {
    use crate::checklist::records::text_hash;
    use crate::session::saved_history::SavedHistory;
    let fx = fixture(&[], &[]).await;
    record_send(&fx, &turn()).await;
    fx.agent
        .apply_transcript_frame(&user_frame("message_end", &turn()))
        .await;
    let live = first_user(&fx).await;

    let dir = crate::test_scratch::path("card-parity");
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let path = dir.join("c.jsonl");
    // A session-file entry type, not an OMP wire frame, so keep it out of the schema-drift scan.
    let entry_type = "message";
    let entry = json!({"type": entry_type, "id": "e1", "message": {
        "role": "user", "content": [{"type": "text", "text": turn()}], "timestamp": 1}});
    tokio::fs::write(&path, format!("{entry}\n")).await.unwrap();
    let records = [crate::checklist::model::SendRecord {
        checklist_id: "c1".into(),
        item_id: "i1".into(),
        rev: 3,
        action: SendAction::Ask,
        text_hash: text_hash(&turn()),
    }];
    let session_dir = dir.to_string_lossy().into_owned();
    let file = path.to_string_lossy().into_owned();
    let history = crate::session::saved_history_cache::load_saved_history(
        Some(&session_dir),
        Some(&file),
        &records,
    )
    .await;
    let SavedHistory::Items(items) = history else {
        panic!("expected items");
    };
    let reloaded = items
        .iter()
        .find_map(|item| match &**item {
            TranscriptItem::User { text, source, .. } => Some((text.clone(), source.clone())),
            _ => None,
        })
        .unwrap();

    assert_eq!(live, reloaded);
    fx.finish().await;
}
