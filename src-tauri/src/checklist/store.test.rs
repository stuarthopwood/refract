use std::time::Duration;

use super::*;
use crate::checklist::ops::ErrorCode;

fn live(id: &str) -> LiveSession {
    LiveSession::check(id, |_| true, |_| false).unwrap()
}

fn bump(file: &mut ChecklistFile) -> Result<u64, ChecklistError> {
    file.next_checklist_seq += 1;
    Ok(file.next_checklist_seq)
}

async fn seq(store: &ChecklistStore, id: &str) -> u64 {
    store
        .read(&live(id), |f| f.next_checklist_seq)
        .await
        .unwrap()
}

#[tokio::test]
async fn failed_write_leaves_memory_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let store = ChecklistStore::new(dir.path().to_path_buf());
    store.apply(&live("s1"), bump).await.unwrap();
    // A directory where the file belongs makes the rename of the next write fail.
    let file = dir.path().join("s1.json");
    std::fs::remove_file(&file).unwrap();
    std::fs::create_dir(&file).unwrap();

    let failed = store.apply(&live("s1"), bump).await;

    assert!(matches!(failed, Err(StoreError::StoreFailed(_))));
    assert_eq!(seq(&store, "s1").await, 2);
}

#[tokio::test]
async fn engine_error_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let store = ChecklistStore::new(dir.path().to_path_buf());

    let result = store
        .apply(&live("s1"), |f| {
            f.next_checklist_seq = 99;
            Err::<(), _>(ChecklistError::new(ErrorCode::Conflict))
        })
        .await;

    assert!(matches!(result, Err(StoreError::Op(_))));
    assert_eq!(seq(&store, "s1").await, 1);
    assert!(!dir.path().join("s1.json").exists());
}

#[tokio::test]
async fn two_sessions_do_not_share_lock() {
    let dir = tempfile::tempdir().unwrap();
    let store = ChecklistStore::new(dir.path().to_path_buf());
    let held = store.slot("a").lock_owned().await;

    let other = tokio::time::timeout(Duration::from_secs(5), store.apply(&live("b"), bump)).await;

    assert!(other.unwrap().is_ok());
    drop(held);
}

#[tokio::test]
async fn agent_and_developer_serialise() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(ChecklistStore::new(dir.path().to_path_buf()));
    let mut tasks = Vec::new();
    for _ in 0..20 {
        let store = Arc::clone(&store);
        tasks.push(tokio::spawn(async move {
            store.apply_detached(live("s1"), bump).await.unwrap()
        }));
    }
    let mut seen = Vec::new();
    for task in tasks {
        seen.push(task.await.unwrap());
    }
    seen.sort_unstable();

    assert_eq!(seen, (2..=21).collect::<Vec<u64>>());
}

#[tokio::test]
async fn traversal_session_id_creates_no_file() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("checklists");
    let store = ChecklistStore::new(root.clone());
    for evil in ["../escape", "a/b", "a\\b", "", "..", "x.y"] {
        // The registry stand-in accepts everything, so only the path guard can refuse.
        let result = store.apply(&live(evil), bump).await;
        assert!(matches!(result, Err(StoreError::UnknownSession)), "{evil}");
    }
    assert!(!root.exists());
    assert!(!dir.path().join("escape.json").exists());
}

#[test]
fn unknown_session_rejected() {
    let result = LiveSession::check("s1", |_| false, |_| false);
    assert!(matches!(result, Err(StoreError::UnknownSession)));
}

#[test]
fn deleting_session_rejected() {
    let result = LiveSession::check("s1", |_| true, |_| true);
    assert!(matches!(result, Err(StoreError::SessionDeleting)));
}

#[tokio::test]
async fn tombstoned_entry_cannot_be_recreated() {
    let dir = tempfile::tempdir().unwrap();
    let store = ChecklistStore::new(dir.path().to_path_buf());
    store.apply(&live("s1"), bump).await.unwrap();
    store.discard("s1").await.unwrap();

    let applied = store.apply(&live("s1"), bump).await;
    let read = store.read(&live("s1"), |_| ()).await;

    assert!(matches!(applied, Err(StoreError::Tombstoned)));
    assert!(matches!(read, Err(StoreError::Tombstoned)));
    assert!(!dir.path().join("s1.json").exists());
}

#[tokio::test]
async fn reload_equals_saved() {
    let dir = tempfile::tempdir().unwrap();
    let store = ChecklistStore::new(dir.path().to_path_buf());
    store.apply(&live("s1"), bump).await.unwrap();
    let saved = store.read(&live("s1"), Clone::clone).await.unwrap();

    let reopened = ChecklistStore::new(dir.path().to_path_buf());

    assert_eq!(
        reopened.read(&live("s1"), Clone::clone).await.unwrap(),
        saved
    );
}

#[tokio::test]
async fn newer_version_file_refused_and_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s1.json");
    std::fs::write(&path, br#"{"version": 2}"#).unwrap();
    let store = ChecklistStore::new(dir.path().to_path_buf());

    let result = store.apply(&live("s1"), bump).await;

    assert!(matches!(result, Err(StoreError::StoreUnsupported)));
    assert_eq!(std::fs::read(&path).unwrap(), br#"{"version": 2}"#);
}

#[tokio::test]
async fn agent_apply_completes_when_caller_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(ChecklistStore::new(dir.path().to_path_buf()));
    let held = store.slot("s1").lock_owned().await;

    // The lock is held, so the detached task is spawned but parked; the timeout then drops the caller.
    let caller = tokio::time::timeout(
        Duration::from_millis(50),
        store.apply_detached(live("s1"), bump),
    )
    .await;
    assert!(caller.is_err());
    assert!(!dir.path().join("s1.json").exists());
    drop(held);

    let path = dir.path().join("s1.json");
    for _ in 0..200 {
        if path.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(path.exists());
    assert_eq!(seq(&store, "s1").await, 2);
}
