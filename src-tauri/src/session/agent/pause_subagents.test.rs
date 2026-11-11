// Unit tests for `pause_subagents.rs`, loaded via `#[path]`. A node stub stands in for OMP and
// logs every RPC it receives, so each test asserts the exact wire traffic.
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::omp::process::OmpProcess;
use crate::omp::transcript::TranscriptItem;
use crate::session::agent::SessionAgent;
use crate::store::registry::Session;

const STUB: &str = r#"
const fs = require('fs');
const [log, running, stuck] = process.argv.slice(2);
const live = new Set(running ? running.split(',') : []);
const uncancellable = new Set(stuck ? stuck.split(',') : []);
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
    let data = {};
    if (cmd.type === 'get_subagents') {
      data = { subagents: [...live].map((id) => ({ id })) };
    } else if (cmd.type === 'cancel_subagent') {
      const cancelled = (live.has(cmd.subagentId) || cmd.subagentId.startsWith('late-')) && !uncancellable.has(cmd.subagentId);
      if (cancelled) live.delete(cmd.subagentId);
      data = { cancelled };
    }
    process.stdout.write(
      JSON.stringify({ id: cmd.id, type: 'response', command: cmd.type, success: true, data }) + '\n',
    );
  }
});
"#;

struct Fixture {
    agent: Arc<SessionAgent>,
    log: PathBuf,
}

/// `running` ids are live in the stub; `stuck` ids answer `cancelled:false`.
async fn fixture(running: &[&str], stuck: &[&str]) -> Fixture {
    let session_id = format!("session-pause-subagents-{}", uuid::Uuid::new_v4());
    let dir =
        crate::test_scratch::path(format!("refract-pause-subagents-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let mut registry_store = crate::store::registry::RegistryStore::open(&dir)
        .await
        .unwrap();
    registry_store
        .add_repository(crate::store::registry::Repository {
            id: "repo".to_string(),
            path: dir.join("repo").to_string_lossy().into_owned(),
            name: "repo".to_string(),
            default_branch: "main".to_string(),
            added_at: "2026-11-11T00:00:00.000Z".to_string(),
            color: None,
        })
        .await
        .unwrap();
    registry_store
        .add_session(Session {
            id: session_id.clone(),
            repository_id: "repo".to_string(),
            name: "test".to_string(),
            branch: "feat/test".to_string(),
            base_branch: "main".to_string(),
            worktree_path: dir.join("worktree").to_string_lossy().into_owned(),
            session_dir: None,
            current_conversation: None,
            last_message_count: None,
            last_model: None,
            last_thinking_level: None,
            created_at: "2026-11-11T00:00:00.000Z".to_string(),
            last_activity_at: "2026-11-11T00:00:00.000Z".to_string(),
            archived_at: None,
            hidden_at: None,
            paused_held: None,
            current_turn_subagents: None,
            stopped_on_request_conversation: None,
            stopped_on_request_at_size: None,
            pinned_model: false,
            origin_issue: None,
        })
        .await
        .unwrap();
    let registry = Arc::new(tokio::sync::Mutex::new(registry_store));
    let settings = Arc::new(tokio::sync::Mutex::new(
        crate::store::settings::SettingsStore::open(&dir)
            .await
            .unwrap(),
    ));
    let events =
        crate::events::EventSink::new(Arc::new(std::sync::Mutex::new(None)), registry.clone());
    let manager = crate::session::manager::SessionManager::new(registry, settings, events);
    let agent = manager.get_or_create_agent(&session_id);

    let script = dir.join("stub.js");
    let log = dir.join("rpc.jsonl");
    tokio::fs::write(&script, STUB).await.unwrap();
    let mut command = tokio::process::Command::new("node");
    command
        .arg(&script)
        .arg(&log)
        .arg(running.join(","))
        .arg(stuck.join(","))
        .current_dir(&dir);
    let process = OmpProcess::from_command(command).unwrap();
    agent.state.lock().await.process = Some(Arc::new(process));
    Fixture { agent, log }
}

impl Fixture {
    /// Every command the stub received, in order.
    async fn rpcs(&self) -> Vec<Value> {
        let text = tokio::fs::read_to_string(&self.log)
            .await
            .unwrap_or_default();
        text.lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    async fn rpc_types(&self) -> Vec<String> {
        self.rpcs()
            .await
            .iter()
            .map(|cmd| cmd["type"].as_str().unwrap().to_string())
            .collect()
    }

    async fn cancel_targets(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .rpcs()
            .await
            .iter()
            .filter(|cmd| cmd["type"] == "cancel_subagent")
            .map(|cmd| cmd["subagentId"].as_str().unwrap().to_string())
            .collect();
        ids.sort();
        ids
    }

    async fn cancelled(&self) -> Vec<String> {
        let mut ids = self.agent.state.lock().await.pause.cancelled.clone();
        ids.sort();
        ids
    }

    async fn notices(&self) -> Vec<String> {
        let state = self.agent.state.lock().await;
        state
            .transcript
            .items()
            .iter()
            .filter_map(|item| match &**item {
                TranscriptItem::Notice { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    /// The auto-cancel runs off the frame handler, so poll for its effect.
    async fn until_cancel_sent(&self) {
        for _ in 0..200 {
            if !self.cancel_targets().await.is_empty() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("no cancel_subagent arrived");
    }

    async fn finish(self) {
        let process = self.agent.state.lock().await.process.take().unwrap();
        process.stop().await;
    }
}

fn lifecycle(id: &str, status: &str) -> Value {
    json!({ "type": "subagent_lifecycle", "payload": { "id": id, "status": status, "index": 0 } })
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
    fx.until_cancel_sent().await;

    assert_eq!(fx.cancel_targets().await, ["late-1"]);
    for _ in 0..200 {
        if !fx.notices().await.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(fx.cancelled().await, ["late-1"]);
    assert_eq!(
        fx.notices().await,
        ["Pause cancelled subagent late-1, which started while this Session was paused."]
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
    fx.agent.state.lock().await.pause.resuming = true;
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
    fx.agent.state.lock().await.pause.held = Some(vec!["held text".to_string()]);
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
    fx.agent.resume().await.unwrap();
    assert!(!fx
        .notices()
        .await
        .iter()
        .any(|text| text.starts_with("Resumed.")));
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
