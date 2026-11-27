// The Conversation tree commands against a real `AppState` and a stub omp that logs each command.

use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;

use super::{abort_summary_core, fork_core, label_core, rewind_core, tree_core};
use crate::events::EventSink;
use crate::ipc::AppState;
use crate::omp::process::OmpProcess;
use crate::session::{SessionManager, SessionStatus};
use crate::store::registry::{RegistryStore, Session};
use crate::store::settings::SettingsStore;

/// `entryId` picks the reply: `busy` and `missing` mimic `navigate_tree`'s coded refusals, `cancel` a stopped
/// summary, `bad` and `weird` are `fork`'s message-only errors; a fork switches `get_state` to a second file.
const STUB: &str = r##"
const fs = require('fs');
const [log, initial, forked] = process.argv.slice(2);
let current = initial;
let count = 4;
const msg = (id, role, text, children, label) => ({
  entry: { type: 'message', id, timestamp: '2026-11-27T10:00:00Z', message: { role, content: [{ type: 'text', text }] } },
  children,
  ...(label ? { label } : {}),
});
const tree = {
  leafId: 'l1',
  tree: [{
    entry: { type: 'model_change', id: 'm0' },
    children: [msg('u1', 'user', '  hello\n  world ', [
      msg('a1', 'assistant', 'hi there', [{ entry: { type: 'label', id: 'l1', targetId: 'u1' }, children: [] }]),
    ], 'start')],
  }],
};
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
    const res = { id: cmd.id, type: 'response', command: cmd.type, success: true, data: {} };
    const fail = (error, code) => { res.success = false; res.error = error; if (code) res.code = code; delete res.data; };
    if (cmd.type === 'get_tree') res.data = tree;
    if (cmd.type === 'navigate_tree') {
      if (cmd.entryId === 'busy') fail('Cannot navigate the session tree while work is running', 'session_busy');
      else if (cmd.entryId === 'missing') fail('Entry missing not found', 'entry_not_found');
      else if (cmd.entryId === 'cancel') res.data = { cancelled: true, aborted: true };
      else { count = 2; res.data = { cancelled: false, editorText: 'hello world' }; }
    }
    if (cmd.type === 'set_label' && cmd.entryId === 'nope') fail('Entry nope not found');
    if (cmd.type === 'fork') {
      if (cmd.entryId === 'bad') fail('Invalid entry ID for forking: bad');
      else if (cmd.entryId === 'weird') fail('boom');
      else { current = forked; count = 3; res.data = { cancelled: false }; }
    }
    if (cmd.type === 'get_state') res.data = { sessionFile: current, messageCount: count };
    if (cmd.type === 'get_messages_page') {
      res.data = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 }], totalMessages: 1 };
    }
    process.stdout.write(JSON.stringify(res) + '\n');
  }
});
"##;

const CURRENT_FILE: &str = "2026-11-12T00-00-00-000Z_def.jsonl";
const FORK_FILE: &str = "2026-11-13T00-00-00-000Z_fork.jsonl";

struct Rig {
    state: AppState,
    /// Unique per rig: the delete-in-flight set is process-wide, so tests run in parallel.
    id: String,
    log: PathBuf,
    fork_file: String,
}

fn session_row(id: &str, session_dir: &str, current: &str) -> Session {
    Session {
        id: id.to_string(),
        kind: crate::store::session_kind::SessionKind::Project,
        repository_id: Some("repo".to_string()),
        name: "test".to_string(),
        branch: Some("feat/tree".to_string()),
        base_branch: Some("main".to_string()),
        worktree_path: Some("C:/nowhere/worktree".to_string()),
        session_dir: Some(session_dir.to_string()),
        current_conversation: Some(current.to_string()),
        last_message_count: Some(4),
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

async fn rig(status: SessionStatus) -> Rig {
    let id = format!("session-tree-{}", uuid::Uuid::new_v4());
    let dir = crate::test_scratch::path(format!("conversations-tree-{}", uuid::Uuid::new_v4()));
    let sessions = dir.join("sessions");
    tokio::fs::create_dir_all(&sessions).await.unwrap();
    let body = "{\"type\":\"title\",\"title\":\"t\"}\n{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n";
    let current = sessions.join(CURRENT_FILE);
    let fork_file = sessions.join(FORK_FILE);
    tokio::fs::write(&current, body).await.unwrap();
    tokio::fs::write(&fork_file, body).await.unwrap();
    let (current, fork_file) = (
        current.to_string_lossy().into_owned(),
        fork_file.to_string_lossy().into_owned(),
    );

    let mut registry_store = RegistryStore::open(&dir).await.unwrap();
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
        .add_session(session_row(&id, &sessions.to_string_lossy(), &current))
        .await
        .unwrap();
    let registry = Arc::new(AsyncMutex::new(registry_store));
    let settings = Arc::new(AsyncMutex::new(SettingsStore::open(&dir).await.unwrap()));
    let slot: Arc<StdMutex<Option<tauri::AppHandle>>> = Arc::new(StdMutex::new(None));
    let events = EventSink::new(slot.clone(), registry.clone());
    let session_manager = SessionManager::new(registry.clone(), settings.clone(), events);
    let state = AppState {
        data_dir: dir.clone(),
        registry,
        settings,
        app_handle: slot,
        session_manager,
    };

    let script = dir.join("stub.js");
    let log = dir.join("rpc.jsonl");
    tokio::fs::write(&script, STUB).await.unwrap();
    let mut command = tokio::process::Command::new("node");
    command
        .arg(&script)
        .arg(&log)
        .arg(&current)
        .arg(&fork_file)
        .current_dir(&dir);
    let process = OmpProcess::from_command(command).unwrap();
    state
        .session_manager
        .get_or_create_agent(&id)
        .adopt_process_for_test(process, status)
        .await;
    Rig {
        state,
        id,
        log,
        fork_file,
    }
}

impl Rig {
    /// Every command the stub received, in order.
    async fn commands(&self) -> Vec<Value> {
        tokio::fs::read_to_string(&self.log)
            .await
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .collect()
    }

    async fn command_types(&self) -> Vec<String> {
        self.commands()
            .await
            .iter()
            .map(|c| c["type"].as_str().unwrap().to_string())
            .collect()
    }

    async fn session(&self) -> Session {
        self.state
            .registry
            .lock()
            .await
            .get_session(&self.id)
            .cloned()
            .unwrap()
    }

    async fn finish(self) {
        self.state
            .session_manager
            .get_or_create_agent(&self.id)
            .shutdown()
            .await;
    }
}

#[tokio::test]
async fn tree_core_returns_message_entries_with_labels_and_works_while_busy() {
    let r = rig(SessionStatus::Working).await;
    let tree = tree_core(&r.state, &r.id).await.unwrap();
    let ids: Vec<&str> = tree["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["u1", "a1"]);
    assert_eq!(tree["entries"][0]["label"], "start");
    assert_eq!(tree["entries"][0]["text"], "hello world");
    assert_eq!(tree["entries"][1]["parentId"], "u1");
    assert_eq!(tree["leafId"], "a1");
    r.finish().await;
}

#[tokio::test]
async fn rewind_and_fork_refuse_while_the_session_is_not_idle_without_sending_anything() {
    let r = rig(SessionStatus::Working).await;
    let err = rewind_core(&r.state, &r.id, "u1", false).await.unwrap_err();
    assert_eq!(err.code, "not-idle");
    let err = fork_core(&r.state, &r.id, "u1").await.unwrap_err();
    assert_eq!(err.code, "not-idle");
    assert!(r.commands().await.is_empty());
    r.finish().await;
}

#[tokio::test]
async fn rewind_core_returns_the_editor_text_and_reloads_the_transcript() {
    let r = rig(SessionStatus::Idle).await;
    let out = rewind_core(&r.state, &r.id, "u1", true).await.unwrap();
    assert_eq!(out["cancelled"], false);
    assert_eq!(out["editorText"], "hello world");
    let cmds = r.commands().await;
    assert_eq!(cmds[0]["type"], "navigate_tree");
    assert_eq!(cmds[0]["entryId"], "u1");
    assert_eq!(cmds[0]["summarize"], true);
    assert!(r
        .command_types()
        .await
        .contains(&"get_messages_page".to_string()));
    // A rewind stays in the same Conversation.
    assert!(r
        .session()
        .await
        .current_conversation
        .unwrap()
        .ends_with(CURRENT_FILE));
    r.finish().await;
}

#[tokio::test]
async fn rewind_core_reports_a_cancelled_summary_without_reloading() {
    let r = rig(SessionStatus::Idle).await;
    let out = rewind_core(&r.state, &r.id, "cancel", true).await.unwrap();
    assert_eq!(out["cancelled"], true);
    assert_eq!(r.command_types().await, ["navigate_tree"]);
    r.finish().await;
}

#[tokio::test]
async fn omp_failures_map_to_stable_error_codes() {
    let r = rig(SessionStatus::Idle).await;
    let busy = rewind_core(&r.state, &r.id, "busy", false)
        .await
        .unwrap_err();
    assert_eq!(busy.code, "not-idle");
    let missing = rewind_core(&r.state, &r.id, "missing", false)
        .await
        .unwrap_err();
    assert_eq!(missing.code, "entry-not-found");
    let bad_fork = fork_core(&r.state, &r.id, "bad").await.unwrap_err();
    assert_eq!(bad_fork.code, "entry-not-found");
    let weird = fork_core(&r.state, &r.id, "weird").await.unwrap_err();
    assert_eq!(weird.code, "tree-failed");
    let label = label_core(&r.state, &r.id, "nope", "x").await.unwrap_err();
    assert_eq!(label.code, "entry-not-found");
    // A refused fork never touches the registry.
    assert!(r
        .session()
        .await
        .current_conversation
        .unwrap()
        .ends_with(CURRENT_FILE));
    r.finish().await;
}

#[tokio::test]
async fn fork_core_points_the_registry_at_the_new_file_and_rebaselines_the_count() {
    let r = rig(SessionStatus::Idle).await;
    let out = fork_core(&r.state, &r.id, "u1").await.unwrap();
    assert_eq!(out["file"], r.fork_file.as_str());
    let session = r.session().await;
    assert_eq!(
        session.current_conversation.as_deref(),
        Some(r.fork_file.as_str())
    );
    // Below the 4 last seen, so an unmanaged reattach would raise #449's notice.
    assert_eq!(session.last_message_count, Some(3));
    let cmds = r.commands().await;
    assert_eq!(cmds[0]["type"], "fork");
    assert_eq!(cmds[0]["entryId"], "u1");
    // The side-chat cancel (#789) runs between the fork and the state read.
    let types = r.command_types().await;
    assert!(types.iter().position(|t| t == "get_state") > Some(0));
    r.finish().await;
}

#[tokio::test]
async fn label_core_sends_the_label_and_omits_it_to_clear() {
    let r = rig(SessionStatus::Working).await;
    label_core(&r.state, &r.id, "u1", "  keep  ").await.unwrap();
    label_core(&r.state, &r.id, "u1", "").await.unwrap();
    let cmds = r.commands().await;
    assert_eq!(cmds[0]["label"], "keep");
    assert!(cmds[1].get("label").is_none());
    r.finish().await;
}

#[tokio::test]
async fn abort_summary_core_forwards_to_omp() {
    let r = rig(SessionStatus::Idle).await;
    abort_summary_core(&r.state, &r.id).await.unwrap();
    assert_eq!(r.command_types().await, ["abort_branch_summary"]);
    r.finish().await;
}

#[tokio::test]
async fn tree_core_refuses_an_unknown_session() {
    let r = rig(SessionStatus::Idle).await;
    let err = tree_core(&r.state, "nope").await.unwrap_err();
    assert_eq!(err.code, "not-found");
    r.finish().await;
}
