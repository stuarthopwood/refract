// Session delete, archive and restore against the per-Session checklist file.

use super::tests::{make_repository, make_session, make_state, temp_registry_dir};
use super::*;
use crate::checklist::store::{LiveSession, StoreError};
use crate::git::test_support::init_repo;

fn live(id: &str) -> LiveSession {
    LiveSession::check(id, |_| true, |_| false).unwrap()
}

/// Writes one checklist change through the manager's store and returns the file it landed in.
async fn seed_checklist(state: &AppState, id: &str) -> std::path::PathBuf {
    let store = state.session_manager.checklists();
    store
        .apply(&live(id), |f| {
            f.next_checklist_seq += 1;
            Ok(())
        })
        .await
        .unwrap();
    store.session_file(id).unwrap()
}

async fn wait_until_settled(id: &str) {
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        while delete_in_flight::is_deleting(id) {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the background removal must settle");
}

async fn add_archived_session(state: &AppState, id: &str, archived: bool) {
    let mut store = state.registry.lock().await;
    store
        .add_repository(make_repository("repo-1", "C:/nowhere/repo"))
        .await
        .expect("add_repository");
    let mut row = make_session(id, "repo-1", "C:/nowhere/worktree", "feature");
    if archived {
        row.archived_at = Some("2026-01-01T00:00:00.000Z".to_string());
    }
    store.add_session(row).await.expect("add_session");
}

#[tokio::test]
async fn delete_removes_checklist_file_and_tombstones_the_session() {
    let dir = temp_registry_dir("checklist-delete");
    let state = make_state(&dir).await;
    let repo = init_repo().await;
    state
        .registry
        .lock()
        .await
        .add_repository(make_repository("repo-1", &repo.to_string_lossy()))
        .await
        .expect("add_repository");
    let added = add_worktree_with_generated_name(&repo, "main")
        .await
        .expect("create worktree");
    let session = make_session(
        "checklist-delete",
        "repo-1",
        &added.worktree_path.to_string_lossy(),
        &added.branch,
    );
    state
        .registry
        .lock()
        .await
        .add_session(session)
        .await
        .expect("add_session");
    let file = seed_checklist(&state, "checklist-delete").await;
    assert!(file.exists());

    let args = vec![
        Value::String("checklist-delete".to_string()),
        serde_json::json!({ "confirmed": true }),
    ];
    sessions_delete(state.clone(), args)
        .await
        .expect("delete must succeed");
    wait_until_settled("checklist-delete").await;

    let recreated = state
        .session_manager
        .checklists()
        .apply(&live("checklist-delete"), |_| Ok(()))
        .await;
    assert!(!file.exists());
    assert!(matches!(recreated, Err(StoreError::Tombstoned)));
}

#[tokio::test]
async fn archive_keeps_checklist_file() {
    let dir = temp_registry_dir("checklist-archive");
    let state = make_state(&dir).await;
    add_archived_session(&state, "checklist-archive", false).await;
    let file = seed_checklist(&state, "checklist-archive").await;

    sessions_archive(
        state.clone(),
        vec![Value::String("checklist-archive".to_string())],
    )
    .await
    .expect("archive must succeed");

    assert!(file.exists());
}

#[tokio::test]
async fn restore_finds_checklist() {
    let dir = temp_registry_dir("checklist-restore");
    let state = make_state(&dir).await;
    add_archived_session(&state, "checklist-restore", true).await;
    seed_checklist(&state, "checklist-restore").await;

    sessions_restore(
        state.clone(),
        vec![Value::String("checklist-restore".to_string())],
    )
    .await
    .expect("restore must succeed");

    let seq = state
        .session_manager
        .checklists()
        .read(&live("checklist-restore"), |f| f.next_checklist_seq)
        .await
        .unwrap();
    assert_eq!(seq, 2);
}
