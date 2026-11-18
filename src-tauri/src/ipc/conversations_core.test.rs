// `start_new_core` and `switch_core` against a real `AppState` and a stub omp that logs each command.
// The stopped-Session branch spawns a real omp, so it stays with the live scenarios in the plan.

use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

use tokio::sync::Mutex as AsyncMutex;

use super::{start_new_core, switch_core};
use crate::events::EventSink;
use crate::ipc::sessions_lifecycle::delete_in_flight;
use crate::ipc::AppState;
use crate::omp::process::OmpProcess;
use crate::session::{SessionManager, SessionStatus};
use crate::store::registry::{RegistryStore, Session};
use crate::store::settings::SettingsStore;

/// Logs every command; `get_state` reports the file of the last `switch_session`.
const STUB: &str = r#"
const fs = require('fs');
const [log, initial] = process.argv.slice(2);
let current = initial;
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
    if (cmd.type === 'switch_session') {
      current = cmd.sessionPath;
      res.data = { cancelled: false };
    }
    if (cmd.type === 'get_state') res.data = { sessionFile: current, messageCount: 1 };
    if (cmd.type === 'get_messages_page') {
      res.data = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 }], totalMessages: 1 };
    }
    process.stdout.write(JSON.stringify(res) + '\n');
  }
});
"#;

const FIRST_FILE: &str = "2026-11-11T00-00-00-000Z_abc.jsonl";
const CURRENT_FILE: &str = "2026-11-12T00-00-00-000Z_def.jsonl";

struct Rig {
    state: AppState,
    /// Unique per rig: the delete-in-flight set is process-wide, so tests run in parallel.
    id: String,
    log: PathBuf,
    first: String,
    current: String,
}

fn session_row(id: &str, session_dir: &str, current: &str) -> Session {
    Session {
        id: id.to_string(),
        kind: crate::store::session_kind::SessionKind::Project,
        repository_id: Some("repo".to_string()),
        name: "test".to_string(),
        branch: Some("feat/core".to_string()),
        base_branch: Some("main".to_string()),
        worktree_path: Some("C:/nowhere/worktree".to_string()),
        session_dir: Some(session_dir.to_string()),
        current_conversation: Some(current.to_string()),
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

/// A Session with two stored Conversations and a live stub omp in `status`.
async fn rig(status: SessionStatus) -> Rig {
    let id = format!("session-core-{}", uuid::Uuid::new_v4());
    let dir = crate::test_scratch::path(format!("conversations-core-{}", uuid::Uuid::new_v4()));
    let sessions = dir.join("sessions");
    tokio::fs::create_dir_all(&sessions).await.unwrap();
    let body = "{\"type\":\"title\",\"title\":\"t\"}\n{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n";
    let first = sessions.join(FIRST_FILE);
    let current = sessions.join(CURRENT_FILE);
    tokio::fs::write(&first, body).await.unwrap();
    tokio::fs::write(&current, body).await.unwrap();
    let (first, current) = (
        first.to_string_lossy().into_owned(),
        current.to_string_lossy().into_owned(),
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
        first,
        current,
    }
}

impl Rig {
    /// The command types the stub received, in order.
    async fn commands(&self) -> Vec<String> {
        tokio::fs::read_to_string(&self.log)
            .await
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .map(|v| v["type"].as_str().unwrap().to_string())
            .collect()
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
async fn start_new_core_starts_a_conversation_on_an_idle_session() {
    let r = rig(SessionStatus::Idle).await;

    start_new_core(&r.state, &r.id).await.unwrap();

    assert!(r.commands().await.contains(&"new_session".to_string()));
    r.finish().await;
}

#[tokio::test]
async fn start_new_core_refuses_a_session_that_is_not_idle() {
    let r = rig(SessionStatus::Working).await;

    let err = start_new_core(&r.state, &r.id).await.unwrap_err();

    assert_eq!(err.code, "not-idle");
    assert!(r.commands().await.is_empty());
    r.finish().await;
}

#[tokio::test]
async fn start_new_core_refuses_an_unknown_session() {
    let r = rig(SessionStatus::Idle).await;

    let err = start_new_core(&r.state, "missing").await.unwrap_err();

    assert_eq!(err.code, "not-found");
    r.finish().await;
}

#[tokio::test]
async fn start_new_core_refuses_a_session_being_deleted() {
    let r = rig(SessionStatus::Idle).await;
    let _claim = delete_in_flight::claim(&r.id).unwrap();

    let err = start_new_core(&r.state, &r.id).await.unwrap_err();

    assert_eq!(err.code, delete_in_flight::ALREADY_DELETING);
    assert!(r.commands().await.is_empty());
    r.finish().await;
}

#[tokio::test]
async fn switch_core_opens_another_listed_conversation() {
    let r = rig(SessionStatus::Idle).await;

    switch_core(&r.state, &r.id, &r.first).await.unwrap();

    assert!(r.commands().await.contains(&"switch_session".to_string()));
    r.finish().await;
}

#[tokio::test]
async fn switch_core_reloads_the_current_conversation_instead_of_reporting_unchanged() {
    // Deviation (T002): `unchanged` is the tool's call, from `is_current`; the IPC `open` always reloads.
    let r = rig(SessionStatus::Idle).await;

    switch_core(&r.state, &r.id, &r.current).await.unwrap();

    assert!(r.commands().await.contains(&"switch_session".to_string()));
    r.finish().await;
}

#[tokio::test]
async fn switch_core_refuses_a_file_that_is_not_one_of_the_sessions_conversations() {
    let r = rig(SessionStatus::Idle).await;

    let err = switch_core(
        &r.state,
        &r.id,
        "C:/elsewhere/2026-11-11T00-00-00-000Z_zzz.jsonl",
    )
    .await
    .unwrap_err();

    assert_eq!(err.code, "invalid-argument");
    assert!(r.commands().await.is_empty());
    r.finish().await;
}

#[tokio::test]
async fn switch_core_refuses_an_unknown_session() {
    let r = rig(SessionStatus::Idle).await;

    let err = switch_core(&r.state, "missing", &r.first).await.unwrap_err();

    assert_eq!(err.code, "not-found");
    r.finish().await;
}

#[tokio::test]
async fn switch_core_refuses_a_session_that_is_not_idle() {
    let r = rig(SessionStatus::Working).await;

    let err = switch_core(&r.state, &r.id, &r.first).await.unwrap_err();

    assert_eq!(err.code, "not-idle");
    assert!(r.commands().await.is_empty());
    r.finish().await;
}
