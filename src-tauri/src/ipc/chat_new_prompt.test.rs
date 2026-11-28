// `chat.send` with `/new <prompt>` (#1827) against a real `AppState` and a stub omp that logs each command.
// The Stopped-Session launch path is covered where the helper lives (`start_with_message.test.rs`).

use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::{json, Value};
use tokio::sync::Mutex as AsyncMutex;

use super::chat_send;
use crate::events::EventSink;
use crate::ipc::AppState;
use crate::omp::process::OmpProcess;
use crate::session::{SessionManager, SessionStatus};
use crate::store::registry::{RegistryStore, Repository, Session};
use crate::store::settings::SettingsStore;

/// Logs every command; `cfg.fail` names a command type that answers `success:false`.
const STUB: &str = r#"
const fs = require('fs');
const [log, configJson] = process.argv.slice(2);
const cfg = JSON.parse(configJson);
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
    process.stdout.write(JSON.stringify(res) + '\n');
  }
});
"#;

struct Rig {
    state: AppState,
    id: String,
    log: PathBuf,
}

fn session_row(id: &str) -> Session {
    Session {
        id: id.to_string(),
        kind: crate::store::session_kind::SessionKind::Project,
        repository_id: Some("repo".to_string()),
        name: "test".to_string(),
        branch: Some("feat/core".to_string()),
        base_branch: Some("main".to_string()),
        worktree_path: Some("C:/nowhere/worktree".to_string()),
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

/// A Session with a live stub omp in `status`; `cfg` is the stub's config.
async fn rig(status: SessionStatus, cfg: Value) -> Rig {
    let id = format!("session-new-prompt-{}", uuid::Uuid::new_v4());
    let dir = crate::test_scratch::path(format!("chat-new-prompt-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();

    let mut registry_store = RegistryStore::open(&dir).await.unwrap();
    registry_store
        .add_repository(Repository {
            id: "repo".to_string(),
            path: dir.join("repo").to_string_lossy().into_owned(),
            name: "repo".to_string(),
            default_branch: "main".to_string(),
            added_at: "2026-11-11T00:00:00.000Z".to_string(),
            color: None,
        })
        .await
        .unwrap();
    registry_store.add_session(session_row(&id)).await.unwrap();
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
        .arg(cfg.to_string())
        .current_dir(&dir);
    state
        .session_manager
        .get_or_create_agent(&id)
        .adopt_process_for_test(OmpProcess::from_command(command).unwrap(), status)
        .await;
    Rig { state, id, log }
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

    async fn types(&self) -> Vec<String> {
        self.commands()
            .await
            .iter()
            .map(|c| c["type"].as_str().unwrap().to_string())
            .collect()
    }

    async fn send(&self, text: &str, images: Option<Value>) -> Result<Value, crate::ipc::IpcError> {
        let mut args = vec![json!(self.id), json!(text)];
        args.extend(images);
        chat_send(self.state.clone(), args).await
    }

    async fn finish(self) {
        self.state
            .session_manager
            .get_or_create_agent(&self.id)
            .shutdown()
            .await;
    }
}

fn png_image() -> Value {
    let mut bytes = vec![0x89u8, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    bytes.extend_from_slice(&[0, 0, 0, 13]);
    bytes.extend_from_slice(b"IHDR");
    bytes.extend_from_slice(&4u32.to_be_bytes());
    bytes.extend_from_slice(&3u32.to_be_bytes());
    json!([{ "type": "image", "data": crate::omp::images::base64_encode(&bytes), "mimeType": "image/png" }])
}

#[tokio::test]
async fn new_with_a_prompt_starts_a_conversation_then_sends_the_prompt_as_given() {
    let r = rig(SessionStatus::Idle, json!({})).await;

    let sent = r.send("/new  fix the bug in parser", None).await.unwrap();

    assert_eq!(sent, json!({ "queued": false }));
    let types = r.types().await;
    let new_at = types.iter().position(|t| t == "new_session").unwrap();
    let prompt_at = types.iter().position(|t| t == "prompt").unwrap();
    assert!(new_at < prompt_at, "Conversation first, then the message");
    let prompt = &r.commands().await[prompt_at];
    assert_eq!(prompt["message"], "fix the bug in parser");
    r.finish().await;
}

#[tokio::test]
async fn bare_new_still_only_starts_a_conversation() {
    let r = rig(SessionStatus::Idle, json!({})).await;

    r.send("/new", None).await.unwrap();

    let types = r.types().await;
    assert!(types.contains(&"new_session".to_string()));
    assert!(!types.contains(&"prompt".to_string()));
    r.finish().await;
}

#[tokio::test]
async fn new_followed_only_by_whitespace_is_the_bare_path_and_sends_no_prompt() {
    for text in ["/new   ", "/new \t"] {
        let r = rig(SessionStatus::Idle, json!({})).await;

        let sent = r.send(text, None).await.unwrap();

        assert_eq!(sent, json!({ "queued": false }), "{text:?}");
        let types = r.types().await;
        assert!(types.contains(&"new_session".to_string()), "{text:?}");
        assert!(!types.contains(&"prompt".to_string()), "{text:?}");
        r.finish().await;
    }
}

#[tokio::test]
async fn new_with_a_slash_command_as_the_prompt_is_refused_before_any_conversation_starts() {
    for text in ["/new /compact", "/new   /compact now", "/new /new hello"] {
        let r = rig(SessionStatus::Idle, json!({})).await;

        let err = r.send(text, None).await.unwrap_err();

        assert_eq!(err.code, "unsupported-arguments", "{text:?}");
        assert!(err.message.contains("slash command"), "{text:?}");
        assert!(r.commands().await.is_empty(), "{text:?}");
        r.finish().await;
    }
}

#[tokio::test]
async fn a_slash_later_in_the_prompt_is_not_a_command_and_is_sent_as_given() {
    let r = rig(SessionStatus::Idle, json!({})).await;

    r.send("/new see src/main.rs", None).await.unwrap();

    let commands = r.commands().await;
    let prompt = commands.iter().find(|c| c["type"] == "prompt").unwrap();
    assert_eq!(prompt["message"], "see src/main.rs");
    r.finish().await;
}

#[tokio::test]
async fn new_with_a_prompt_on_a_paused_session_reports_the_message_as_held() {
    let r = rig(SessionStatus::Idle, json!({})).await;
    r.state
        .session_manager
        .get_or_create_agent(&r.id)
        .pause()
        .await
        .unwrap();

    let sent = r.send("/new hello", None).await.unwrap();

    assert_eq!(sent, json!({ "queued": true }));
    let types = r.types().await;
    assert!(types.contains(&"new_session".to_string()));
    assert!(!types.contains(&"prompt".to_string()), "held, not sent");
    r.finish().await;
}

#[tokio::test]
async fn new_with_a_prompt_and_an_image_is_refused_before_any_conversation_starts() {
    let r = rig(SessionStatus::Idle, json!({})).await;

    let err = r
        .send("/new look at this", Some(png_image()))
        .await
        .unwrap_err();

    assert_eq!(err.code, "unsupported-arguments");
    assert_eq!(
        err.message,
        "Slash commands can't carry attached files. Remove them and try again."
    );
    assert!(r.commands().await.is_empty());
    r.finish().await;
}

#[tokio::test]
async fn a_send_failure_after_the_new_conversation_is_a_distinct_error_with_no_second_conversation()
{
    let r = rig(SessionStatus::Idle, json!({ "fail": "prompt" })).await;

    let err = r.send("/new hello", None).await.unwrap_err();

    assert_eq!(err.code, "new-prompt-send-failed");
    assert!(err.message.contains("new Conversation was started"));
    assert!(err.message.ends_with("Press Enter to send it again."));
    let new_sessions = r
        .types()
        .await
        .iter()
        .filter(|t| *t == "new_session")
        .count();
    assert_eq!(new_sessions, 1);
    r.finish().await;
}

#[tokio::test]
async fn a_failure_before_the_new_conversation_keeps_the_plain_chat_error_and_sends_nothing() {
    let r = rig(SessionStatus::Idle, json!({ "fail": "new_session" })).await;

    let err = r.send("/new hello", None).await.unwrap_err();

    assert_ne!(err.code, "new-prompt-send-failed");
    assert!(!r.types().await.contains(&"prompt".to_string()));
    r.finish().await;
}

#[tokio::test]
async fn new_with_a_prompt_on_a_busy_session_is_refused_as_not_idle() {
    let r = rig(SessionStatus::Working, json!({})).await;

    let err = r.send("/new hello", None).await.unwrap_err();

    assert_eq!(err.code, "not-idle");
    assert!(r.commands().await.is_empty());
    r.finish().await;
}
