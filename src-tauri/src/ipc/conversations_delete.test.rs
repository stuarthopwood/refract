// `delete_conversation_core` against a real `AppState` with temp dirs only; never a real `~/.omp`.
// The Session id is unique per rig because the delete-in-flight sets are process-wide.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use tokio::sync::Mutex as AsyncMutex;

use super::*;
use crate::events::EventSink;
use crate::omp::process::OmpProcess;
use crate::session::SessionManager;
use crate::store::registry::{RegistryStore, Repository, Session};
use crate::store::settings::SettingsStore;

const DOOMED: &str = "2026-11-11T00-00-00-000Z_abc.jsonl";
const CURRENT: &str = "2026-11-12T00-00-00-000Z_def.jsonl";

struct Rig {
    state: AppState,
    id: String,
    /// The Sessions root every delete is bounded by.
    root: PathBuf,
    session_dir: PathBuf,
    scratch: PathBuf,
}

fn session_row(id: &str, session_dir: &Path, current: &Path) -> Session {
    Session {
        id: id.to_string(),
        kind: crate::store::session_kind::SessionKind::Project,
        repository_id: Some("repo".to_string()),
        name: "test".to_string(),
        branch: Some("feat/delete".to_string()),
        base_branch: Some("main".to_string()),
        worktree_path: Some("C:/nowhere/worktree".to_string()),
        session_dir: Some(session_dir.to_string_lossy().into_owned()),
        current_conversation: Some(current.to_string_lossy().into_owned()),
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

/// `status` of `None` leaves the Session without a live agent, which reads as stopped.
/// `session_dir_is_root` registers the Sessions root itself as the Session's folder.
async fn rig(status: Option<SessionStatus>, session_dir_is_root: bool) -> Rig {
    let id = format!("session-delete-{}", uuid::Uuid::new_v4());
    let scratch =
        crate::test_scratch::path(format!("conversations-delete-{}", uuid::Uuid::new_v4()));
    let root = scratch.join("sessions-root");
    let session_dir = if session_dir_is_root {
        root.clone()
    } else {
        root.join("--proj--")
    };
    tokio::fs::create_dir_all(&session_dir).await.unwrap();
    let body = "{\"type\":\"title\",\"title\":\"t\"}\n";
    tokio::fs::write(session_dir.join(DOOMED), body)
        .await
        .unwrap();
    tokio::fs::write(session_dir.join(CURRENT), body)
        .await
        .unwrap();

    let mut registry_store = RegistryStore::open(&scratch).await.unwrap();
    registry_store
        .add_repository(Repository {
            id: "repo".to_string(),
            path: scratch.join("repo").to_string_lossy().into_owned(),
            name: "repo".to_string(),
            default_branch: "main".to_string(),
            added_at: "2026-11-11T00:00:00.000Z".to_string(),
            color: None,
        })
        .await
        .unwrap();
    registry_store
        .add_session(session_row(&id, &session_dir, &session_dir.join(CURRENT)))
        .await
        .unwrap();
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

    if let Some(status) = status {
        let mut command = tokio::process::Command::new("node");
        command
            .arg("-e")
            .arg("setInterval(() => {}, 1000)")
            .current_dir(&scratch);
        let process = OmpProcess::from_command(command).unwrap();
        state
            .session_manager
            .get_or_create_agent(&id)
            .adopt_process_for_test(process, status)
            .await;
    }
    Rig {
        state,
        id,
        root,
        session_dir,
        scratch,
    }
}

impl Rig {
    fn doomed(&self) -> String {
        self.session_dir.join(DOOMED).to_string_lossy().into_owned()
    }

    async fn delete(&self, file: &str) -> Result<u64, IpcError> {
        delete_conversation_core(&self.state, &self.id, file, &self.root).await
    }

    async fn finish(self) {
        if let Some(agent) = self.state.session_manager.get_agent(&self.id) {
            agent.shutdown().await;
        }
    }
}

/// Creates a directory junction (no privilege needed on Windows). Skips outside CI when the OS
/// refuses; fails in CI so the refusal is never silently unproven there.
fn junction_or_skip(link: &Path, target: &Path) -> bool {
    let made = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .is_ok_and(|out| out.status.success());
    if !made {
        assert!(
            std::env::var("CI").is_err(),
            "junction creation failed in CI: {link:?} -> {target:?}"
        );
        eprintln!("skipping: mklink refused (sandbox restriction, not CI)");
    }
    made
}

#[tokio::test]
async fn deletes_the_jsonl_and_its_artifact_folder_and_reports_the_bytes_freed() {
    let r = rig(None, false).await;
    let artifact = artifact_dir(&r.session_dir.join(DOOMED));
    tokio::fs::create_dir_all(artifact.join("deep"))
        .await
        .unwrap();
    tokio::fs::write(artifact.join("deep").join("a.bin"), [0u8; 7])
        .await
        .unwrap();
    let before = conversation_size_bytes(&r.session_dir.join(DOOMED));

    let freed = r.delete(&r.doomed()).await.unwrap();

    assert_eq!(freed, before);
    assert!(freed >= 7);
    assert!(tokio::fs::metadata(r.session_dir.join(DOOMED))
        .await
        .is_err());
    assert!(tokio::fs::metadata(&artifact).await.is_err());
    r.finish().await;
}

#[tokio::test]
async fn deletes_only_the_chosen_conversation() {
    let r = rig(None, false).await;
    tokio::fs::write(r.session_dir.join("notes.txt"), "keep")
        .await
        .unwrap();

    r.delete(&r.doomed()).await.unwrap();

    assert!(tokio::fs::metadata(r.session_dir.join(CURRENT))
        .await
        .is_ok());
    assert!(tokio::fs::metadata(r.session_dir.join("notes.txt"))
        .await
        .is_ok());
    r.finish().await;
}

#[tokio::test]
async fn an_already_gone_conversation_is_ok_with_nothing_freed() {
    let r = rig(None, false).await;
    tokio::fs::remove_file(r.session_dir.join(DOOMED))
        .await
        .unwrap();

    assert_eq!(r.delete(&r.doomed()).await.unwrap(), 0);
    r.finish().await;
}

#[tokio::test]
async fn deletes_from_an_idle_session() {
    let r = rig(Some(SessionStatus::Idle), false).await;

    assert!(r.delete(&r.doomed()).await.is_ok());
    r.finish().await;
}

#[tokio::test]
async fn refuses_the_current_conversation() {
    let r = rig(None, false).await;
    let current = r.session_dir.join(CURRENT);

    let err = r.delete(&current.to_string_lossy()).await.unwrap_err();

    assert_eq!(err.code, "current-conversation");
    assert!(tokio::fs::metadata(&current).await.is_ok());
    r.finish().await;
}

#[tokio::test]
async fn refuses_a_conversation_of_a_session_that_is_not_idle() {
    let r = rig(Some(SessionStatus::Working), false).await;

    let err = r.delete(&r.doomed()).await.unwrap_err();

    assert_eq!(err.code, "not-idle");
    assert!(tokio::fs::metadata(r.session_dir.join(DOOMED))
        .await
        .is_ok());
    r.finish().await;
}

#[tokio::test]
async fn refuses_a_session_that_is_being_deleted() {
    let r = rig(None, false).await;
    let _claim = delete_in_flight::claim(&r.id).unwrap();

    let err = r.delete(&r.doomed()).await.unwrap_err();

    assert_eq!(err.code, delete_in_flight::ALREADY_DELETING);
    assert!(tokio::fs::metadata(r.session_dir.join(DOOMED))
        .await
        .is_ok());
    r.finish().await;
}

#[tokio::test]
async fn refuses_an_unknown_session() {
    let r = rig(None, false).await;

    let err = delete_conversation_core(&r.state, "missing", &r.doomed(), &r.root)
        .await
        .unwrap_err();

    assert_eq!(err.code, "not-found");
    assert!(tokio::fs::metadata(r.session_dir.join(DOOMED))
        .await
        .is_ok());
    r.finish().await;
}

#[tokio::test]
async fn refuses_a_file_that_is_not_in_the_sessions_own_folder() {
    let r = rig(None, false).await;
    let other_dir = r.root.join("--other--");
    tokio::fs::create_dir_all(&other_dir).await.unwrap();
    let other = other_dir.join(DOOMED);
    tokio::fs::write(&other, "x").await.unwrap();

    let err = r.delete(&other.to_string_lossy()).await.unwrap_err();

    assert_eq!(err.code, "invalid-argument");
    assert!(tokio::fs::metadata(&other).await.is_ok());
    r.finish().await;
}

#[tokio::test]
async fn refuses_a_file_that_is_not_a_conversation_name() {
    let r = rig(None, false).await;
    let notes = r.session_dir.join("notes.txt");
    tokio::fs::write(&notes, "keep").await.unwrap();

    let err = r.delete(&notes.to_string_lossy()).await.unwrap_err();

    assert_eq!(err.code, "invalid-argument");
    assert!(tokio::fs::metadata(&notes).await.is_ok());
    r.finish().await;
}

#[tokio::test]
async fn refuses_a_path_that_climbs_out_with_a_parent_component() {
    let r = rig(None, false).await;
    let sneaky = r.session_dir.join("..").join("--proj--").join(DOOMED);

    let err = r.delete(&sneaky.to_string_lossy()).await.unwrap_err();

    assert_eq!(err.code, "invalid-argument");
    assert!(tokio::fs::metadata(r.session_dir.join(DOOMED))
        .await
        .is_ok());
    r.finish().await;
}

#[tokio::test]
async fn refuses_a_session_folder_outside_the_sessions_root() {
    let r = rig(None, false).await;
    let elsewhere = r.scratch.join("elsewhere-root");
    tokio::fs::create_dir_all(&elsewhere).await.unwrap();

    let err = delete_conversation_core(&r.state, &r.id, &r.doomed(), &elsewhere)
        .await
        .unwrap_err();

    assert_eq!(err.code, "invalid-argument");
    assert!(tokio::fs::metadata(r.session_dir.join(DOOMED))
        .await
        .is_ok());
    r.finish().await;
}

#[tokio::test]
async fn refuses_a_session_folder_that_is_the_sessions_root_itself() {
    let r = rig(None, true).await;

    let err = r.delete(&r.doomed()).await.unwrap_err();

    assert_eq!(err.code, "invalid-argument");
    assert!(tokio::fs::metadata(r.root.join(DOOMED)).await.is_ok());
    r.finish().await;
}

#[tokio::test]
async fn refuses_a_conversation_file_that_is_a_link() {
    let r = rig(None, false).await;
    let outside = r.scratch.join("outside");
    tokio::fs::create_dir_all(&outside).await.unwrap();
    let target = outside.join("real.jsonl");
    tokio::fs::write(&target, "x").await.unwrap();
    let link = r.session_dir.join("2026-11-13T00-00-00-000Z_lnk.jsonl");
    if std::os::windows::fs::symlink_file(&target, &link).is_err() {
        assert!(
            std::env::var("CI").is_err(),
            "file symlink creation failed in CI"
        );
        eprintln!("skipping: file symlinks need a privilege this sandbox lacks");
        r.finish().await;
        return;
    }

    let err = r.delete(&link.to_string_lossy()).await.unwrap_err();

    assert_eq!(err.code, "invalid-argument");
    assert!(tokio::fs::metadata(&target).await.is_ok());
    r.finish().await;
}

#[tokio::test]
async fn refuses_an_artifact_folder_that_is_a_link_and_leaves_its_target_alone() {
    let r = rig(None, false).await;
    let outside = r.scratch.join("outside");
    tokio::fs::create_dir_all(&outside).await.unwrap();
    tokio::fs::write(outside.join("precious.bin"), [0u8; 9])
        .await
        .unwrap();
    if !junction_or_skip(&artifact_dir(&r.session_dir.join(DOOMED)), &outside) {
        r.finish().await;
        return;
    }

    let err = r.delete(&r.doomed()).await.unwrap_err();

    assert_eq!(err.code, "invalid-argument");
    assert!(tokio::fs::metadata(outside.join("precious.bin"))
        .await
        .is_ok());
    assert!(tokio::fs::metadata(r.session_dir.join(DOOMED))
        .await
        .is_ok());
    r.finish().await;
}

#[tokio::test]
async fn refuses_a_delete_already_in_flight_for_the_same_file() {
    let r = rig(None, false).await;
    let _claim = claim_file(&r.doomed()).unwrap();

    let err = r.delete(&r.doomed()).await.unwrap_err();

    assert_eq!(err.code, delete_in_flight::ALREADY_DELETING);
    assert!(tokio::fs::metadata(r.session_dir.join(DOOMED))
        .await
        .is_ok());
    r.finish().await;
}

#[tokio::test]
async fn the_in_flight_claim_is_released_so_a_retry_can_run() {
    let r = rig(None, false).await;
    drop(claim_file(&r.doomed()).unwrap());

    assert!(r.delete(&r.doomed()).await.is_ok());
    r.finish().await;
}
