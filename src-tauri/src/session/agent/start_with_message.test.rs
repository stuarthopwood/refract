// `start_conversation_then_send`: event order, note flag, failure stages and the sidecar key.

use std::sync::Arc;

use serde_json::{json, Value};

use super::{FirstMessage, StartStage};
use crate::omp::process::OmpProcess;
use crate::session::agent::pause_subagents::fixture::{fixture_with, Fixture, Stub};
use crate::session::agent::SessionStatus;
use crate::store::handoff_notes;

/// Logs every command; `cfg.fail` names a command type that answers `success:false`,
/// `cfg.file` is the `sessionFile` `get_state` reports once `new_session` ran (or after the prompt).
const STUB: &str = r#"
const fs = require('fs');
const [log, configJson] = process.argv.slice(2);
const cfg = JSON.parse(configJson);
let fresh = false;
let prompted = false;
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let at;
  while ((at = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, at);
    buf = buf.slice(at + 1);
    if (!line.trim()) continue;
    fs.appendFileSync(log, line + '\n');
    const cmd = JSON.parse(line);
    const res = { id: cmd.id, type: 'response', command: cmd.type, success: cmd.type !== cfg.fail, data: {} };
    if (!res.success) res.error = 'refused';
    if (cmd.type === 'new_session') fresh = true;
    if (cmd.type === 'prompt') prompted = true;
    if (cmd.type === 'get_state' && cfg.file && (fresh || prompted) && (!cfg.afterPrompt || prompted)) {
      res.data = { sessionFile: cfg.file };
    }
    process.stdout.write(JSON.stringify(res) + '\n');
  }
});
"#;

struct Rig {
    fx: Fixture,
    log: std::path::PathBuf,
    dir: std::path::PathBuf,
}

async fn rig(cfg: Value) -> Rig {
    let fx = fixture_with(Stub {
        stopped: true,
        ..Stub::default()
    })
    .await;
    let dir = crate::test_scratch::path(format!("start-with-message-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let script = dir.join("stub.js");
    let log = dir.join("rpc.jsonl");
    tokio::fs::write(&script, STUB).await.unwrap();
    let mut command = tokio::process::Command::new("node");
    command
        .arg(&script)
        .arg(&log)
        .arg(cfg.to_string())
        .current_dir(&dir);
    {
        let mut state = fx.agent.state.lock().await;
        state.process = Some(Arc::new(OmpProcess::from_command(command).unwrap()));
        state.status = SessionStatus::Idle;
    }
    handoff_notes::use_dir_for_test(dir.clone());
    // The event line goes into the same log as the commands, so the order is one file.
    let probe_log = log.clone();
    fx.agent.events().set_conversation_probe(move || {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&probe_log)
            .unwrap();
        writeln!(file, "{}", json!({ "kind": "EVENT" })).unwrap();
    });
    Rig { fx, log, dir }
}

impl Rig {
    async fn types(&self) -> Vec<String> {
        tokio::fs::read_to_string(&self.log)
            .await
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .map(|v| {
                v["type"]
                    .as_str()
                    .or(v["kind"].as_str())
                    .unwrap()
                    .to_string()
            })
            .collect()
    }
}

fn first(note: bool) -> FirstMessage {
    FirstMessage {
        text: "hello".to_string(),
        handoff_note: note,
    }
}

#[tokio::test]
async fn the_event_fires_before_the_first_send() {
    let r = rig(json!({})).await;
    r.fx.agent
        .start_conversation_then_send(first(false))
        .await
        .unwrap();
    let types = r.types().await;
    let event = types.iter().position(|t| t == "EVENT").unwrap();
    let prompt = types.iter().position(|t| t == "prompt").unwrap();
    let new = types.iter().position(|t| t == "new_session").unwrap();
    assert!(new < event && event < prompt, "{types:?}");
    r.fx.finish().await;
}

#[tokio::test]
async fn the_note_flag_is_set_before_the_send() {
    let r = rig(json!({ "file": "n.jsonl" })).await;
    r.fx.agent
        .start_conversation_then_send(first(true))
        .await
        .unwrap();
    assert!(r.fx.agent.state.lock().await.handoff.note_live);
    // The key was read before the send, so get_state precedes the prompt.
    let types = r.types().await;
    let state = types.iter().position(|t| t == "get_state").unwrap();
    let prompt = types.iter().position(|t| t == "prompt").unwrap();
    assert!(state < prompt, "{types:?}");
    assert!(handoff_notes::contains_in(&r.dir, "n.jsonl").await);
    r.fx.finish().await;
}

#[tokio::test]
async fn a_failure_before_the_new_conversation_is_before_new() {
    let r = rig(json!({ "fail": "new_session" })).await;
    let err =
        r.fx.agent
            .start_conversation_then_send(first(false))
            .await
            .unwrap_err();
    assert_eq!(err.stage, StartStage::BeforeNew);
    assert!(!r.types().await.contains(&"prompt".to_string()));
    r.fx.finish().await;
}

#[tokio::test]
async fn a_send_failure_is_after_new_and_starts_no_second_conversation() {
    let r = rig(json!({ "fail": "prompt" })).await;
    let err =
        r.fx.agent
            .start_conversation_then_send(first(false))
            .await
            .unwrap_err();
    assert_eq!(err.stage, StartStage::AfterNew);
    let new_sessions = r
        .types()
        .await
        .iter()
        .filter(|t| *t == "new_session")
        .count();
    assert_eq!(new_sessions, 1);
    r.fx.finish().await;
}

#[tokio::test]
async fn a_missing_file_name_is_read_again_after_the_send() {
    let r = rig(json!({ "file": "late.jsonl", "afterPrompt": true })).await;
    r.fx.agent
        .start_conversation_then_send(first(true))
        .await
        .unwrap();
    assert!(handoff_notes::contains_in(&r.dir, "late.jsonl").await);
    r.fx.finish().await;
}

#[tokio::test]
async fn an_unreadable_state_still_succeeds() {
    let r = rig(json!({ "fail": "get_state" })).await;
    r.fx.agent
        .start_conversation_then_send(first(true))
        .await
        .unwrap();
    r.fx.finish().await;
}

#[tokio::test]
async fn a_plain_message_records_nothing_in_the_sidecar() {
    // `start_new_conversation` reads state itself, so only the sidecar is asserted.
    let r = rig(json!({ "file": "p.jsonl" })).await;
    r.fx.agent
        .start_conversation_then_send(first(false))
        .await
        .unwrap();
    assert!(!handoff_notes::contains_in(&r.dir, "p.jsonl").await);
    r.fx.finish().await;
}

#[tokio::test]
async fn the_send_result_reports_not_queued_for_an_idle_session() {
    let r = rig(json!({})).await;
    let sent =
        r.fx.agent
            .start_conversation_and_send(first(false))
            .await
            .unwrap();
    assert_eq!(sent, json!({ "queued": false }));
    r.fx.finish().await;
}

#[tokio::test]
async fn a_paused_session_holds_the_first_message_and_reports_it_queued() {
    let r = rig(json!({})).await;
    r.fx.agent.pause().await.unwrap();
    let sent =
        r.fx.agent
            .start_conversation_and_send(first(false))
            .await
            .unwrap();
    assert_eq!(sent, json!({ "queued": true }));
    let types = r.types().await;
    assert!(types.contains(&"new_session".to_string()), "{types:?}");
    assert!(!types.contains(&"prompt".to_string()), "held, not sent: {types:?}");
    r.fx.finish().await;
}

#[tokio::test]
async fn a_stopped_session_takes_the_launch_path() {
    let fx = fixture_with(Stub {
        stopped: true,
        ..Stub::default()
    })
    .await;
    assert_eq!(fx.agent.status().await, SessionStatus::Stopped);
    let err = fx
        .agent
        .start_conversation_then_send(first(false))
        .await
        .unwrap_err();
    // The idle path would say "not-idle"; the launch path stops at the missing worktree.
    assert_eq!(err.stage, StartStage::BeforeNew);
    assert_ne!(err.error.code, "not-idle");
    fx.finish().await;
}

#[tokio::test]
async fn launching_from_stopped_discards_the_pending_notice() {
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
    fx.agent.state.lock().await.pending_agent_notice = vec!["Handoff failed: old".to_string()];

    // The launch itself may or may not succeed here; only the notice reset is under test.
    let _ = fx.agent.start_with_conversation(None).await;

    assert!(fx.agent.state.lock().await.pending_agent_notice.is_empty());
    fx.finish().await;
}
