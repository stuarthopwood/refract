// A checklist turn keeps its label across every frame, and a forged or unrecorded one stays text.

use std::sync::Arc;

use serde_json::{json, Value};

use super::{clear, mark_cards, merge_relaunch_history, needs_match};
use crate::agent_tools::checklist_envelope::wrap;
use crate::checklist::model::SendAction;
use crate::checklist::records::add_send_record;
use crate::checklist::store::LiveSession;
use crate::omp::process::OmpProcess;
use crate::omp::transcript::{MessageSource, TranscriptItem, TranscriptState};
use crate::session::agent::pause_subagents::fixture::{fixture, fixture_with, Fixture, Stub};
use crate::session::agent::SessionStatus;

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

#[test]
fn a_tag_split_across_text_parts_still_reads_the_store() {
    let split = json!({
        "type": "message_end",
        "message": { "role": "user", "content": [
            { "type": "text", "text": "<checklist" },
            { "type": "text", "text": "-item rest" },
        ] },
    });

    assert!(needs_match(&split));
    assert!(!needs_match(&user_frame("message_end", "<checklist-iteX")));
    assert!(!needs_match(&user_frame("message_end", "<check")));
}

#[tokio::test]
async fn a_remembered_card_is_not_applied_to_text_it_did_not_match() {
    let fx = fixture(&[], &[]).await;
    record_send(&fx, &turn()).await;
    fx.agent
        .apply_transcript_frame(&user_frame("message_start", &turn()))
        .await;
    {
        let mut state = fx.agent.state.lock().await;
        let mut rebuilt = state.transcript.items()[0].as_ref().clone();
        if let TranscriptItem::User { text, source, .. } = &mut rebuilt {
            *text = "someone else's text".into();
            *source = None;
        }
        state.transcript.upsert_item(rebuilt);
        mark_cards(&mut state);
    }

    assert_eq!(first_user(&fx).await, ("someone else's text".into(), None));
    fx.finish().await;
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

// The wiring below drives the real entry points that rebuild the transcript from stored history.

/// Serves `argv[3]` as the one stored user message of the switched-to file.
const HISTORY_STUB: &str = r#"
const [file, text] = process.argv.slice(2);
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let at;
  while ((at = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, at);
    buf = buf.slice(at + 1);
    if (!line.trim()) continue;
    const cmd = JSON.parse(line);
    const res = { id: cmd.id, type: 'response', command: cmd.type, success: true, data: {} };
    if (cmd.type === 'switch_session') res.data = { cancelled: false };
    if (cmd.type === 'get_state') res.data = { sessionFile: file, messageCount: 1 };
    if (cmd.type === 'get_messages_page') {
      res.data = { messages: [{ role: 'user', content: [{ type: 'text', text }], timestamp: 1 }], totalMessages: 1 };
    }
    process.stdout.write(JSON.stringify(res) + '\n');
  }
});
"#;

/// Gives the fixture's agent an idle process whose history is the single message `text`.
async fn idle_serving(fx: &Fixture, file: &str, text: &str) {
    let dir = crate::test_scratch::path(format!("card-wiring-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let script = dir.join("history-stub.js");
    tokio::fs::write(&script, HISTORY_STUB).await.unwrap();
    let mut command = tokio::process::Command::new("node");
    command.arg(&script).arg(file).arg(text).current_dir(&dir);
    let process = OmpProcess::from_command(command).unwrap();
    crate::store::handoff_notes::use_dir_for_test(dir);
    let mut state = fx.agent.state.lock().await;
    state.process = Some(Arc::new(process));
    state.status = SessionStatus::Idle;
}

fn stored_message(text: &str) -> Value {
    json!({ "role": "user", "content": [{ "type": "text", "text": text }], "timestamp": 1 })
}

#[tokio::test]
async fn opening_a_conversation_labels_its_recorded_card() {
    let fx = fixture(&[], &[]).await;
    record_send(&fx, &turn()).await;
    idle_serving(&fx, "c.jsonl", &turn()).await;

    fx.agent.open_conversation("c.jsonl".into()).await.unwrap();

    assert_eq!(first_user(&fx).await, ("what next?".into(), card_source()));
    fx.finish().await;
}

#[tokio::test]
async fn starting_a_new_conversation_forgets_the_old_cards() {
    let fx = fixture(&[], &[]).await;
    record_send(&fx, &turn()).await;
    idle_serving(&fx, "c.jsonl", "unused").await;
    fx.agent
        .apply_transcript_frame(&user_frame("message_start", &turn()))
        .await;
    assert_eq!(first_user(&fx).await, ("what next?".into(), card_source()));

    fx.agent.start_new_conversation().await.unwrap();
    {
        let mut state = fx.agent.state.lock().await;
        fx.agent
            .apply_frame_locked(&mut state, &user_frame("message_end", &turn()));
    }

    assert_eq!(first_user(&fx).await, (turn(), None));
    fx.finish().await;
}

#[tokio::test]
async fn a_relaunch_merge_labels_a_recorded_card() {
    let fx = fixture(&[], &[]).await;
    record_send(&fx, &turn()).await;
    let records = fx.agent.checklist_send_records().await;
    {
        // The one call `launch` makes with the fetched history.
        let mut state = fx.agent.state.lock().await;
        merge_relaunch_history(&mut state, &[stored_message(&turn())], false, &records);
    }

    assert_eq!(first_user(&fx).await, ("what next?".into(), card_source()));
    fx.finish().await;
}

#[tokio::test]
async fn a_relaunch_after_a_switch_does_not_carry_the_old_card() {
    let fx = fixture(&[], &[]).await;
    record_send(&fx, &turn()).await;
    idle_serving(&fx, "c.jsonl", &turn()).await;
    fx.agent.open_conversation("c.jsonl".into()).await.unwrap();
    assert_eq!(first_user(&fx).await, ("what next?".into(), card_source()));

    // The relaunched history carries the same raw turn, but its record is gone.
    {
        let mut state = fx.agent.state.lock().await;
        state.transcript = TranscriptState::new();
        merge_relaunch_history(&mut state, &[stored_message(&turn())], false, &[]);
    }

    assert_eq!(first_user(&fx).await, (turn(), None));
    fx.finish().await;
}

#[tokio::test]
async fn a_stopped_sessions_snapshot_labels_its_saved_card() {
    let fx = fixture_with(Stub {
        stopped: true,
        ..Stub::default()
    })
    .await;
    record_send(&fx, &turn()).await;
    let dir = crate::test_scratch::path(format!("card-snapshot-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let file = dir.join("c.jsonl");
    let entry_type = "message";
    let entry = json!({ "type": entry_type, "id": "e1", "message": stored_message(&turn()) });
    tokio::fs::write(&file, format!("{entry}\n")).await.unwrap();
    crate::store::handoff_notes::use_dir_for_test(dir.clone());
    let patch = crate::store::registry::SessionPatch {
        session_dir: Some(dir.to_string_lossy().into_owned()),
        current_conversation: Some(Some(file.to_string_lossy().into_owned())),
        ..Default::default()
    };
    let registry = fx.agent.registry().clone();
    registry
        .lock()
        .await
        .update_session(&fx.agent.session_id, patch)
        .await
        .unwrap();
    let session = registry
        .lock()
        .await
        .get_session(&fx.agent.session_id)
        .cloned()
        .unwrap();

    let snapshot = crate::ipc::conversations::build_snapshot(&session, &fx.agent, None).await;

    let item = &snapshot["runtime"]["transcript"][0];
    assert_eq!(item["text"], "what next?");
    assert_eq!(item["source"]["kind"], "checklist-item", "{item}");
    fx.finish().await;
}
