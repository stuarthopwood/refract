// Tests for the Project gate in `sessions_restore` (#1859), split from `sessions_lifecycle_tests.rs`
// for the 600-line cap.

use super::tests::{make_repository, make_session, make_state, temp_registry_dir};
use super::*;

async fn is_archived(state: &AppState) -> bool {
    state
        .registry
        .lock()
        .await
        .get_session("s1")
        .unwrap()
        .archived_at
        .is_some()
}

#[tokio::test]
async fn sessions_restore_waits_for_the_project_gate() {
    let dir = temp_registry_dir("restore-gate");
    let state = make_state(&dir).await;
    {
        let mut store = state.registry.lock().await;
        store
            .add_repository(make_repository("repo-1", "C:/nowhere/repo"))
            .await
            .expect("add_repository");
        let mut row = make_session("s1", "repo-1", "C:/nowhere/s1", "s1");
        row.archived_at = Some("2026-01-01T00:00:00.000Z".to_string());
        store.add_session(row).await.expect("add_session");
    }

    let held = crate::agent_tools::tree_gate::lock("repo-1").await;
    let task = tokio::spawn(sessions_restore(
        state.clone(),
        vec![Value::String("s1".to_string())],
    ));
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(is_archived(&state).await, "restore must wait for the gate");
    drop(held);
    task.await.unwrap().expect("restore");
    assert!(!is_archived(&state).await);
}
