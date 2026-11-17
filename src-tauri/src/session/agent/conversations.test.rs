// The `/new` guard: a never-started Session is a no-op, anything else keeps its old behaviour.
// Plus the handoff-note flag across `start_new_conversation` and `open_conversation` (#1861).

use std::sync::Arc;

use super::{new_conversation_is_noop, SessionStatus};
use crate::omp::process::OmpProcess;
use crate::omp::transcript::{MessageSource, TranscriptItem};
use crate::session::agent::pause_subagents::fixture::{fixture, Fixture};
use crate::store::handoff_notes;

#[test]
fn a_never_started_session_makes_new_a_no_op() {
    assert!(new_conversation_is_noop(
        SessionStatus::Stopped,
        false,
        Some("not-started")
    ));
    assert!(new_conversation_is_noop(
        SessionStatus::Stopped,
        false,
        None
    ));
}

#[test]
fn a_running_session_keeps_the_existing_new_behaviour() {
    assert!(!new_conversation_is_noop(SessionStatus::Idle, true, None));
    assert!(!new_conversation_is_noop(
        SessionStatus::Working,
        true,
        None
    ));
}

#[test]
fn a_stopped_session_that_once_ran_is_not_a_no_op() {
    assert!(!new_conversation_is_noop(
        SessionStatus::Stopped,
        false,
        Some("crashed")
    ));
    assert!(!new_conversation_is_noop(
        SessionStatus::Stopped,
        true,
        Some("not-started")
    ));
}

/// Answers a switch to `file` with one stored user message.
const SWITCH_STUB: &str = r#"
const file = process.argv[2];
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
      res.data = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 }], totalMessages: 1 };
    }
    process.stdout.write(JSON.stringify(res) + '\n');
  }
});
"#;

/// An idle Session whose omp serves `file`, with the sidecar pointed at a scratch dir.
async fn idle_on(file: &str) -> (Fixture, std::path::PathBuf) {
    let fx = fixture(&[], &[]).await;
    let dir = crate::test_scratch::path("open-conversation");
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let script = dir.join("switch-stub.js");
    tokio::fs::write(&script, SWITCH_STUB).await.unwrap();
    let mut command = tokio::process::Command::new("node");
    command.arg(&script).arg(file).current_dir(&dir);
    let process = OmpProcess::from_command(command).unwrap();
    {
        let mut state = fx.agent.state.lock().await;
        state.process = Some(Arc::new(process));
        state.status = SessionStatus::Idle;
    }
    handoff_notes::use_dir_for_test(dir.clone());
    (fx, dir)
}

fn first_user_source(items: &[Arc<TranscriptItem>]) -> Option<Option<MessageSource>> {
    items.iter().find_map(|item| match &**item {
        TranscriptItem::User { source, .. } => Some(source.clone()),
        _ => None,
    })
}

#[tokio::test]
async fn starting_a_new_conversation_clears_the_flag() {
    let (fx, _dir) = idle_on("a.jsonl").await;
    fx.agent.state.lock().await.handoff.note_live = true;

    fx.agent.start_new_conversation().await.unwrap();

    assert!(!fx.agent.state.lock().await.handoff.note_live);
    fx.finish().await;
}

#[tokio::test]
async fn opening_a_listed_file_sets_the_flag_and_labels_the_first_message() {
    let (fx, dir) = idle_on("note.jsonl").await;
    handoff_notes::record_in(&dir, "note.jsonl", 1).await;

    fx.agent
        .open_conversation("note.jsonl".into())
        .await
        .unwrap();

    let state = fx.agent.state.lock().await;
    assert!(state.handoff.note_live);
    assert_eq!(
        first_user_source(state.transcript.items()),
        Some(Some(MessageSource::Handoff))
    );
    drop(state);
    fx.finish().await;
}

#[tokio::test]
async fn opening_an_unlisted_file_leaves_the_flag_false() {
    let (fx, _dir) = idle_on("plain.jsonl").await;
    fx.agent.state.lock().await.handoff.note_live = true;

    fx.agent
        .open_conversation("plain.jsonl".into())
        .await
        .unwrap();

    let state = fx.agent.state.lock().await;
    assert!(!state.handoff.note_live);
    assert_eq!(first_user_source(state.transcript.items()), Some(None));
    drop(state);
    fx.finish().await;
}
