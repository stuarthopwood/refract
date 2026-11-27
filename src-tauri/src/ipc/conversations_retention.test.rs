// Retention preview and run against a real `AppState` with temp dirs only; never a real `~/.omp`.
// Session ids are unique per rig because the delete-in-flight sets are process-wide.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime};

use tokio::sync::Mutex as AsyncMutex;

use super::*;
use crate::events::EventSink;
use crate::omp::process::OmpProcess;
use crate::session::SessionManager;
use crate::store::registry::{RegistryStore, Repository, Session};
use crate::store::settings::SettingsStore;

const OLD: &str = "2026-01-01T00-00-00-000Z_old.jsonl";
const FRESH: &str = "2026-02-01T00-00-00-000Z_new.jsonl";
const CURRENT: &str = "2026-01-02T00-00-00-000Z_cur.jsonl";
const ON_30: ConversationRetention = ConversationRetention {
    enabled: true,
    days: 30,
};

struct Rig {
    state: AppState,
    root: PathBuf,
    ids: Vec<String>,
    dirs: Vec<PathBuf>,
}

fn session_row(id: &str, dir: &Path, current: &Path) -> Session {
    Session {
        id: id.to_string(),
        kind: crate::store::session_kind::SessionKind::Project,
        repository_id: Some("repo".to_string()),
        name: "test".to_string(),
        branch: Some(format!("feat/retention-{id}")),
        base_branch: Some("main".to_string()),
        worktree_path: Some(format!("C:/nowhere/worktree-{id}")),
        session_dir: Some(dir.to_string_lossy().into_owned()),
        current_conversation: Some(current.to_string_lossy().into_owned()),
        last_message_count: None,
        last_model: None,
        last_thinking_level: None,
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        last_activity_at: "2026-01-01T00:00:00.000Z".to_string(),
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

fn age(path: &Path, now: SystemTime, days: u64) {
    let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
    file.set_modified(now - Duration::from_secs(days * SECONDS_PER_DAY))
        .unwrap();
}

/// One Session per entry of `layout`: `(folder name, status)`. Entries sharing a folder name share
/// the folder. Each folder holds an old, a fresh and a current Conversation; `None` leaves the
/// Session without a live agent, which reads as stopped.
async fn rig(layout: &[(&str, Option<SessionStatus>)], now: SystemTime) -> Rig {
    let scratch = crate::test_scratch::path(format!("conv-retention-{}", uuid::Uuid::new_v4()));
    let root = scratch.join("sessions-root");
    let mut registry_store = RegistryStore::open(&scratch).await.unwrap();
    registry_store
        .add_repository(Repository {
            id: "repo".to_string(),
            path: scratch.join("repo").to_string_lossy().into_owned(),
            name: "repo".to_string(),
            default_branch: "main".to_string(),
            added_at: "2026-01-01T00:00:00.000Z".to_string(),
            color: None,
        })
        .await
        .unwrap();
    let body = "{\"type\":\"title\",\"title\":\"t\"}\n";
    let (mut ids, mut dirs) = (Vec::new(), Vec::new());
    for (name, _) in layout {
        let dir = if *name == "<root>" {
            root.clone()
        } else {
            root.join(name)
        };
        if !dirs.contains(&dir) {
            tokio::fs::create_dir_all(&dir).await.unwrap();
            for (file, days) in [(OLD, 100), (FRESH, 1), (CURRENT, 100)] {
                tokio::fs::write(dir.join(file), body).await.unwrap();
                age(&dir.join(file), now, days);
            }
            dirs.push(dir.clone());
        }
        let id = format!("retention-{}", uuid::Uuid::new_v4());
        registry_store
            .add_session(session_row(&id, &dir, &dir.join(CURRENT)))
            .await
            .unwrap();
        ids.push(id);
    }
    let registry = Arc::new(AsyncMutex::new(registry_store));
    let settings = Arc::new(AsyncMutex::new(
        SettingsStore::open(&scratch).await.unwrap(),
    ));
    let slot: Arc<StdMutex<Option<tauri::AppHandle>>> = Arc::new(StdMutex::new(None));
    let events = EventSink::new(slot.clone(), registry.clone());
    let session_manager = SessionManager::new(registry.clone(), settings.clone(), events);
    let state = AppState {
        data_dir: scratch.clone(),
        registry,
        settings,
        app_handle: slot,
        session_manager,
    };
    for (id, (_, status)) in ids.iter().zip(layout) {
        let Some(status) = *status else {
            continue;
        };
        let mut command = tokio::process::Command::new("node");
        command
            .arg("-e")
            .arg("setInterval(() => {}, 1000)")
            .current_dir(&scratch);
        let process = OmpProcess::from_command(command).unwrap();
        state
            .session_manager
            .get_or_create_agent(id)
            .adopt_process_for_test(process, status)
            .await;
    }
    Rig {
        state,
        root,
        ids,
        dirs,
    }
}

impl Rig {
    async fn finish(self) {
        for id in &self.ids {
            if let Some(agent) = self.state.session_manager.get_agent(id) {
                agent.shutdown().await;
            }
        }
    }
}

fn exists(dir: &Path, file: &str) -> bool {
    std::fs::symlink_metadata(dir.join(file)).is_ok()
}

fn files(preview: &RetentionPreview) -> Vec<String> {
    preview
        .candidates
        .iter()
        .map(|c| {
            Path::new(&c.file)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        })
        .collect()
}

#[tokio::test]
async fn retention_is_off_by_default_so_preview_and_run_do_nothing() {
    let now = SystemTime::now();
    let r = rig(&[("a", None)], now).await;
    let off = ConversationRetention::default();
    assert!(!off.enabled);

    let preview = preview_core(&r.state, &r.root, off, now).await;
    let run = run_core(&r.state, &r.root, off, now).await;

    assert!(preview.candidates.is_empty());
    assert_eq!((run.deleted, run.failed, run.bytes_freed), (0, 0, 0));
    assert!(exists(&r.dirs[0], OLD));
    r.finish().await;
}

#[tokio::test]
async fn preview_lists_the_aged_conversations_without_deleting() {
    let now = SystemTime::now();
    let r = rig(&[("a", None)], now).await;

    let preview = preview_core(&r.state, &r.root, ON_30, now).await;

    assert_eq!(files(&preview), vec![OLD.to_string()]);
    assert_eq!(preview.candidates[0].session_id, r.ids[0]);
    assert_eq!(preview.total_bytes, preview.candidates[0].size_bytes);
    assert!(preview.total_bytes > 0);
    assert!(exists(&r.dirs[0], OLD));
    r.finish().await;
}

#[tokio::test]
async fn run_deletes_only_aged_eligible_files_with_their_artifact_folders() {
    let now = SystemTime::now();
    let r = rig(&[("a", None)], now).await;
    let artifact = r.dirs[0].join("2026-01-01T00-00-00-000Z_old");
    tokio::fs::create_dir_all(&artifact).await.unwrap();
    tokio::fs::write(artifact.join("a.bin"), [0u8; 9])
        .await
        .unwrap();
    let expected = conversation_size_bytes(&r.dirs[0].join(OLD));

    let run = run_core(&r.state, &r.root, ON_30, now).await;

    assert_eq!((run.deleted, run.failed), (1, 0));
    assert_eq!(run.bytes_freed, expected);
    assert!(!exists(&r.dirs[0], OLD));
    assert!(!artifact.exists());
    assert!(exists(&r.dirs[0], FRESH));
    assert!(exists(&r.dirs[0], CURRENT));
    r.finish().await;
}

#[tokio::test]
async fn a_file_inside_the_window_is_kept() {
    let now = SystemTime::now();
    let r = rig(&[("a", None)], now).await;
    age(&r.dirs[0].join(OLD), now, 29);

    let preview = preview_core(&r.state, &r.root, ON_30, now).await;

    assert!(preview.candidates.is_empty());
    r.finish().await;
}

#[tokio::test]
async fn the_current_conversation_is_never_listed_or_deleted() {
    let now = SystemTime::now();
    let r = rig(&[("a", None)], now).await;

    let preview = preview_core(&r.state, &r.root, ON_30, now).await;
    run_core(&r.state, &r.root, ON_30, now).await;

    assert!(!files(&preview).contains(&CURRENT.to_string()));
    assert!(exists(&r.dirs[0], CURRENT));
    r.finish().await;
}

#[tokio::test]
async fn a_session_that_is_not_idle_is_skipped() {
    let now = SystemTime::now();
    let r = rig(
        &[("busy", Some(SessionStatus::Working)), ("quiet", None)],
        now,
    )
    .await;

    let run = run_core(&r.state, &r.root, ON_30, now).await;

    assert_eq!(run.deleted, 1);
    assert!(exists(&r.dirs[0], OLD));
    assert!(!exists(&r.dirs[1], OLD));
    r.finish().await;
}

#[tokio::test]
async fn an_idle_session_is_eligible() {
    let now = SystemTime::now();
    let r = rig(&[("idle", Some(SessionStatus::Idle))], now).await;

    let run = run_core(&r.state, &r.root, ON_30, now).await;

    assert_eq!(run.deleted, 1);
    r.finish().await;
}

#[tokio::test]
async fn a_session_being_deleted_is_skipped() {
    let now = SystemTime::now();
    let r = rig(&[("a", None)], now).await;
    let _claim = delete_in_flight::claim(&r.ids[0]).unwrap();

    let preview = preview_core(&r.state, &r.root, ON_30, now).await;
    let run = run_core(&r.state, &r.root, ON_30, now).await;

    assert!(preview.candidates.is_empty());
    assert_eq!(run.deleted, 0);
    assert!(exists(&r.dirs[0], OLD));
    r.finish().await;
}

#[tokio::test]
async fn a_folder_shared_with_a_busy_session_is_skipped_whole() {
    let now = SystemTime::now();
    let r = rig(
        &[("shared", None), ("shared", Some(SessionStatus::Working))],
        now,
    )
    .await;

    let preview = preview_core(&r.state, &r.root, ON_30, now).await;

    assert!(preview.candidates.is_empty());
    assert!(exists(&r.dirs[0], OLD));
    r.finish().await;
}

#[tokio::test]
async fn a_shared_folder_of_quiet_sessions_is_listed_once() {
    let now = SystemTime::now();
    let r = rig(&[("shared", None), ("shared", None)], now).await;

    let preview = preview_core(&r.state, &r.root, ON_30, now).await;

    assert_eq!(files(&preview), vec![OLD.to_string()]);
    r.finish().await;
}

#[tokio::test]
async fn a_session_folder_that_is_the_sessions_root_is_never_touched() {
    let now = SystemTime::now();
    let r = rig(&[("<root>", None)], now).await;

    let preview = preview_core(&r.state, &r.root, ON_30, now).await;
    let run = run_core(&r.state, &r.root, ON_30, now).await;

    assert!(preview.candidates.is_empty());
    assert_eq!(run.deleted, 0);
    assert!(exists(&r.dirs[0], OLD));
    r.finish().await;
}

#[tokio::test]
async fn files_that_are_not_conversations_are_left_alone() {
    let now = SystemTime::now();
    let r = rig(&[("a", None)], now).await;
    let notes = r.dirs[0].join("notes.txt");
    tokio::fs::write(&notes, "keep").await.unwrap();
    age(&notes, now, 400);

    run_core(&r.state, &r.root, ON_30, now).await;

    assert!(notes.exists());
    r.finish().await;
}
