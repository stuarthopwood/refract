// The settle hook (#1861): a handoff queued mid-turn runs once the Session is idle, retries once, then posts a notice.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::omp::process::OmpProcess;
use crate::session::agent::handoff_queue::{try_queue, HandoffAction};
use crate::session::agent::pause_subagents::fixture::{fixture_with, Fixture, Stub};
use crate::session::agent::SessionStatus;
use crate::store::handoff_notes;

/// Logs every command. `cfg.fail` names a command type that answers `success:false` for its first
/// `cfg.failTimes` calls (every call when unset).
const STUB: &str = r#"
const fs = require('fs');
const [log, configJson] = process.argv.slice(2);
const cfg = JSON.parse(configJson);
const failed = {};
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
    let success = true;
    if (cmd.type === cfg.fail) {
      failed[cmd.type] = (failed[cmd.type] || 0) + 1;
      success = failed[cmd.type] > (cfg.failTimes === undefined ? Infinity : cfg.failTimes);
    }
    const res = { id: cmd.id, type: 'response', command: cmd.type, success, data: {} };
    if (!success) res.error = 'refused';
    process.stdout.write(JSON.stringify(res) + '\n');
  }
});
"#;

struct Rig {
    fx: Fixture,
    log: std::path::PathBuf,
}

async fn rig(cfg: Value) -> Rig {
    let fx = fixture_with(Stub {
        stopped: true,
        ..Stub::default()
    })
    .await;
    let dir = crate::test_scratch::path(format!("frame-settle-{}", uuid::Uuid::new_v4()));
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
        // A turn is running: the generation is odd and the action is queued against it.
        state.status = SessionStatus::Working;
        state.turn_generation = 1;
    }
    handoff_notes::use_dir_for_test(dir);
    Rig { fx, log }
}

impl Rig {
    async fn queue(&self, action: HandoffAction, sender: Option<(String, String)>) {
        let mut state = self.fx.agent.state.lock().await;
        try_queue(&mut state, action, sender, false).unwrap();
    }

    async fn commands(&self) -> Vec<Value> {
        tokio::fs::read_to_string(&self.log)
            .await
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    async fn count(&self, kind: &str) -> usize {
        self.commands()
            .await
            .iter()
            .filter(|c| c["type"] == kind)
            .count()
    }

    async fn failure_notices(&self) -> Vec<String> {
        self.fx
            .notices()
            .await
            .into_iter()
            .filter(|n| n.starts_with("Handoff failed"))
            .collect()
    }

    /// Settles the queued turn and runs the action to its end, off the spawned task.
    async fn settle_and_run(&self) {
        self.fx.agent.state.lock().await.turn_generation = 2;
        self.fx
            .agent
            .set_status(SessionStatus::Idle, None, None)
            .await;
        self.fx.agent.run_settled_handoff(2).await;
    }
}

fn new_with(prompt: &str) -> HandoffAction {
    HandoffAction::New {
        prompt: prompt.to_string(),
    }
}

#[tokio::test]
async fn settle_takes_the_slot_after_idle_and_starts_the_conversation() {
    let r = rig(json!({})).await;
    r.queue(new_with("carry on"), None).await;

    r.fx.agent
        .handle_frame(json!({ "type": "session_settled" }))
        .await;

    // The run is spawned, so poll for its prompt.
    let mut types = Vec::new();
    for _ in 0..200 {
        types = r
            .commands()
            .await
            .iter()
            .map(|c| c["type"].as_str().unwrap().to_string())
            .collect();
        if types.iter().any(|t| t == "prompt") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let new = types.iter().position(|t| t == "new_session").unwrap();
    let prompt = types.iter().position(|t| t == "prompt").unwrap();
    assert!(new < prompt, "{types:?}");
    let sent = r
        .commands()
        .await
        .into_iter()
        .find(|c| c["type"] == "prompt")
        .unwrap();
    assert!(sent["message"].as_str().unwrap().contains("carry on"));
    assert!(r.fx.agent.state.lock().await.queued_handoff.is_none());
    r.fx.finish().await;
}

#[tokio::test]
async fn a_send_failure_is_retried_once_without_a_second_conversation() {
    let r = rig(json!({ "fail": "prompt", "failTimes": 1 })).await;
    r.queue(new_with("note"), None).await;

    r.settle_and_run().await;

    assert_eq!(r.count("new_session").await, 1);
    assert_eq!(r.count("prompt").await, 2);
    assert!(r.failure_notices().await.is_empty());
    r.fx.finish().await;
}

#[tokio::test]
async fn a_second_send_failure_posts_the_handoff_failed_notice() {
    let r = rig(json!({ "fail": "prompt" })).await;
    r.queue(new_with("note"), None).await;

    r.settle_and_run().await;

    assert_eq!(r.count("new_session").await, 1);
    assert_eq!(r.count("prompt").await, 2);
    assert_eq!(r.failure_notices().await.len(), 1);
    // Read the notice before taking the state lock: `failure_notices` takes it too.
    let notice = r.failure_notices().await.remove(0);
    assert_eq!(
        r.fx.agent.state.lock().await.pending_agent_notice,
        Some(notice)
    );
    r.fx.finish().await;
}

#[tokio::test]
async fn a_failure_before_the_new_conversation_retries_the_whole_start() {
    let r = rig(json!({ "fail": "new_session" })).await;
    r.queue(new_with("note"), None).await;

    r.settle_and_run().await;

    assert_eq!(r.count("new_session").await, 2);
    assert_eq!(r.count("prompt").await, 0);
    assert_eq!(r.failure_notices().await.len(), 1);
    r.fx.finish().await;
}

#[tokio::test]
async fn a_failed_switch_is_retried_once_then_posts_the_notice() {
    let r = rig(json!({ "fail": "switch_session" })).await;
    r.queue(
        HandoffAction::Switch {
            file: "b.jsonl".to_string(),
        },
        None,
    )
    .await;

    r.settle_and_run().await;

    assert_eq!(r.count("switch_session").await, 2);
    assert_eq!(r.failure_notices().await.len(), 1);
    r.fx.finish().await;
}

#[tokio::test]
async fn a_follow_up_turn_that_already_started_keeps_the_slot() {
    let r = rig(json!({})).await;
    r.queue(new_with("later"), None).await;
    // The settled turn's follow-up began before the run looked: the Session is working again.
    {
        let mut state = r.fx.agent.state.lock().await;
        state.turn_generation = 3;
        state.status = SessionStatus::Working;
    }

    r.fx.agent.run_settled_handoff(2).await;

    assert!(r.fx.agent.state.lock().await.queued_handoff.is_some());
    assert_eq!(r.count("new_session").await, 0);
    r.fx.finish().await;
}
