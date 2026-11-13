// Shared fixture for the pause tests (`pause_subagents` and `pause`). A node stub stands in for OMP and
// logs every RPC it receives, so each test asserts the exact wire traffic.
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::task::JoinHandle;

use crate::omp::process::OmpProcess;
use crate::omp::transcript::TranscriptItem;
use crate::session::agent::{AgentError, SessionAgent};
use crate::store::registry::Session;

const STUB: &str = r#"
const fs = require('fs');
const [log, gateFile, configJson] = process.argv.slice(2);
const cfg = JSON.parse(configJson);
const live = new Set(cfg.running);
const uncancellable = new Set(cfg.stuck);
function reply(cmd, success, data, error) {
  const body = { id: cmd.id, type: 'response', command: cmd.type, success };
  if (success) body.data = data;
  else body.error = error;
  process.stdout.write(JSON.stringify(body) + '\n');
}
function answer(cmd) {
  if (cmd.type === 'get_subagents') {
    if (cfg.listError) return reply(cmd, false, null, cfg.listError);
    return reply(cmd, true, { subagents: [...live].map((id) => ({ id })) });
  }
  if (cmd.type === 'cancel_subagent') {
    const error = cfg.cancelErrors[cmd.subagentId];
    if (error) return reply(cmd, false, null, error);
    const cancelled = (live.has(cmd.subagentId) || cmd.subagentId.startsWith('late-')) && !uncancellable.has(cmd.subagentId);
    if (cancelled) live.delete(cmd.subagentId);
    return reply(cmd, true, { cancelled });
  }
  return reply(cmd, true, {});
}
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
    if (cmd.type !== cfg.gated) {
      answer(cmd);
      continue;
    }
    // A gated command is logged on arrival but answered only once the test releases it.
    const timer = setInterval(() => {
      if (!fs.existsSync(gateFile)) return;
      clearInterval(timer);
      answer(cmd);
    }, 10);
  }
});
"#;

/// What the stub OMP does. `running` ids are live; `stuck` ids answer `cancelled:false`.
#[derive(Default)]
pub(in crate::session::agent) struct Stub<'a> {
    pub running: &'a [&'a str],
    pub stuck: &'a [&'a str],
    /// `get_subagents` answers `success:false` with this error.
    pub list_error: Option<&'a str>,
    /// `cancel_subagent` for the id answers `success:false` with the error.
    pub cancel_errors: &'a [(&'a str, &'a str)],
    /// Answers to this command type wait for `Fixture::release`.
    pub gated: Option<&'a str>,
    /// The agent has no process, like a stopped Session.
    pub stopped: bool,
}

pub(in crate::session::agent) struct Fixture {
    pub agent: Arc<SessionAgent>,
    pub manager: Arc<crate::session::manager::SessionManager>,
    dir: PathBuf,
    log: PathBuf,
    gate: PathBuf,
}

fn session_row(id: &str, dir: &std::path::Path) -> Session {
    Session {
        id: id.to_string(),
        repository_id: "repo".to_string(),
        name: "test".to_string(),
        branch: format!("feat/{id}"),
        base_branch: "main".to_string(),
        worktree_path: dir
            .join(format!("worktree-{id}"))
            .to_string_lossy()
            .into_owned(),
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
        parent_session_id: None,
    }
}

pub(in crate::session::agent) async fn fixture(running: &[&str], stuck: &[&str]) -> Fixture {
    fixture_with(Stub {
        running,
        stuck,
        ..Stub::default()
    })
    .await
}

pub(in crate::session::agent) async fn fixture_with(stub: Stub<'_>) -> Fixture {
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
        .add_session(session_row(&session_id, &dir))
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
    let gate = dir.join("gate");
    let config = json!({
        "running": stub.running,
        "stuck": stub.stuck,
        "listError": stub.list_error,
        "cancelErrors": stub.cancel_errors.iter().copied().collect::<std::collections::HashMap<_, _>>(),
        "gated": stub.gated,
    });
    tokio::fs::write(&script, STUB).await.unwrap();
    let mut command = tokio::process::Command::new("node");
    command
        .arg(&script)
        .arg(&log)
        .arg(&gate)
        .arg(config.to_string())
        .current_dir(&dir);
    if !stub.stopped {
        let process = OmpProcess::from_command(command).unwrap();
        agent.state.lock().await.process = Some(Arc::new(process));
    }
    Fixture {
        agent,
        manager,
        dir,
        log,
        gate,
    }
}

impl Fixture {
    /// Another Session in the same registry, with no process and a worktree that does not exist.
    pub async fn add_session(&self, id: &str, held: &[&str], archived: bool) {
        let mut row = session_row(id, &self.dir);
        row.paused_held = Some(held.iter().map(|text| text.to_string()).collect());
        row.archived_at = archived.then(|| "2026-11-12T00:00:00.000Z".to_string());
        let registry = self.agent.registry().clone();
        registry.lock().await.add_session(row).await.unwrap();
    }

    /// Another paused Session whose agent already has a live process, so a Resume of it succeeds.
    pub async fn add_live_session(&self, id: &str) {
        self.add_session(id, &[], false).await;
        let mut command = tokio::process::Command::new("node");
        command
            .arg(self.dir.join("stub.js"))
            .arg(self.dir.join(format!("rpc-{id}.jsonl")))
            .arg(self.dir.join(format!("gate-{id}")))
            .arg(json!({ "cancelErrors": {} }).to_string())
            .current_dir(&self.dir);
        let process = OmpProcess::from_command(command).unwrap();
        let agent = self.manager.get_or_create_agent(id);
        agent.state.lock().await.process = Some(Arc::new(process));
    }

    /// Stops the process `add_live_session` gave a Session.
    pub async fn stop_live_session(&self, id: &str) {
        let process = self
            .manager
            .get_or_create_agent(id)
            .state
            .lock()
            .await
            .process
            .take();
        if let Some(process) = process {
            process.stop().await;
        }
    }

    /// Every command the stub received, in order.
    pub async fn rpcs(&self) -> Vec<Value> {
        let text = tokio::fs::read_to_string(&self.log)
            .await
            .unwrap_or_default();
        // A line the stub is still appending parses as nothing and shows up on the next read.
        text.lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    pub async fn rpc_types(&self) -> Vec<String> {
        self.rpcs()
            .await
            .iter()
            .map(|cmd| cmd["type"].as_str().unwrap().to_string())
            .collect()
    }

    pub async fn cancel_targets(&self) -> Vec<String> {
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

    pub async fn cancelled(&self) -> Vec<String> {
        let mut ids = self.agent.state.lock().await.pause.cancelled.clone();
        ids.sort();
        ids
    }

    pub async fn notices(&self) -> Vec<String> {
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

    /// Pause's RPCs and the auto-cancel run off the test's task, so poll for their effect.
    pub async fn until_rpc(&self, kind: &str) {
        for _ in 0..200 {
            if self.rpc_types().await.iter().any(|seen| seen == kind) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("no {kind} arrived");
    }

    pub async fn until_notices(&self, count: usize) {
        for _ in 0..200 {
            if self.notices().await.len() >= count {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("fewer than {count} notices arrived");
    }

    /// Runs `pause` off the test's task, so the test can act while its RPCs are in flight.
    pub fn pause_in_background(&self) -> JoinHandle<Result<Value, AgentError>> {
        let agent = self.agent.clone();
        tokio::spawn(async move { agent.pause().await })
    }

    /// Lets the stub answer every command it holds.
    pub async fn release(&self) {
        tokio::fs::write(&self.gate, "").await.unwrap();
    }

    /// A process a test already stopped or reset is gone, so only a live one is stopped here.
    pub async fn finish(self) {
        let process = self.agent.state.lock().await.process.take();
        if let Some(process) = process {
            process.stop().await;
        }
    }
}

pub(super) fn lifecycle(id: &str, status: &str) -> Value {
    json!({ "type": "subagent_lifecycle", "payload": { "id": id, "status": status, "index": 0 } })
}
