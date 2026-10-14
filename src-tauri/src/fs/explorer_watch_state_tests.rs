// Test module for `explorer_watch_state.rs`, split into this sibling file to stay under the
// 600-line soft cap -- included via `#[path = "explorer_watch_state_tests.rs"] mod tests;`.

use super::*;

fn unique_session(label: &str) -> String {
    format!("{label}-{}", uuid::Uuid::new_v4())
}

#[test]
fn loaded_path_round_trips_and_is_case_insensitive() {
    let session = unique_session("loaded");
    assert!(!is_loaded(&session, "sub"));
    record_loaded_path(&session, "Sub");
    assert!(is_loaded(&session, "sub"));
    assert!(is_loaded(&session, "SUB"));
    assert!(has_loaded_paths(&session));
    forget_file_explorer_session(&session);
    assert!(!has_loaded_paths(&session));
    assert!(!is_loaded(&session, "sub"));
}

#[test]
fn busy_marker_is_ref_counted() {
    let session = unique_session("busy");
    assert!(!is_session_busy(&session));
    mark_session_busy(&session);
    mark_session_busy(&session);
    assert!(is_session_busy(&session));
    unmark_session_busy(&session);
    assert!(is_session_busy(&session));
    unmark_session_busy(&session);
    assert!(!is_session_busy(&session));
}

#[test]
fn begin_worktree_operation_clears_busy_on_drop_without_finish() {
    let session = unique_session("guard-drop");
    {
        let _guard = begin_worktree_operation(&session);
        assert!(is_session_busy(&session));
    }
    // Dropped without `finish()` (the early-`?`-return path): busy must still clear.
    assert!(!is_session_busy(&session));
}

#[test]
fn begin_worktree_operation_finish_clears_busy_and_forgets() {
    let session = unique_session("guard-finish");
    record_loaded_path(&session, "sub");
    let app_handle: Arc<StdMutex<Option<AppHandle>>> = Arc::new(StdMutex::new(None));
    let guard = begin_worktree_operation(&session);
    assert!(is_session_busy(&session));
    guard.finish(&app_handle, WorktreeOperationOutcome::Forgotten);
    assert!(!is_session_busy(&session));
    assert!(!has_loaded_paths(&session));
}

#[tokio::test]
async fn ensure_watcher_refuses_a_busy_session() {
    let session = unique_session("ensure-busy");
    mark_session_busy(&session);
    let dir = std::env::temp_dir().join(format!("refract-watch-state-test-{session}"));
    std::fs::create_dir_all(&dir).unwrap();
    let runtime = tokio::runtime::Handle::current();
    ensure_watcher(
        runtime,
        Arc::new(StdMutex::new(None)),
        None,
        &session,
        &dir,
        None,
        false,
    );
    assert!(!has_watcher(&session));
    unmark_session_busy(&session);
}

#[tokio::test]
async fn ensure_watcher_is_idempotent_and_race_free() {
    let session = unique_session("ensure-race");
    let dir = std::env::temp_dir().join(format!("refract-watch-state-test-{session}"));
    std::fs::create_dir_all(&dir).unwrap();
    let runtime = tokio::runtime::Handle::current();

    // Two concurrent callers for the SAME Session: at most one watcher must survive, and the
    // loser must stop its own just-created watcher rather than orphaning it (gate round 1 fix).
    let mut set = tokio::task::JoinSet::new();
    for _ in 0..2 {
        let runtime = runtime.clone();
        let session = session.clone();
        let dir = dir.clone();
        set.spawn_blocking(move || {
            ensure_watcher(
                runtime,
                Arc::new(StdMutex::new(None)),
                None,
                &session,
                &dir,
                None,
                false,
            );
        });
    }
    while set.join_next().await.is_some() {}

    assert!(has_watcher(&session));
    stop_file_explorer_watcher(&session);
    assert!(!has_watcher(&session));
}

#[tokio::test]
async fn cached_worktree_validity_is_cached_until_forgotten() {
    let session = unique_session("validity");
    let repo = std::env::temp_dir().join(format!("refract-watch-state-repo-{session}"));
    let worktree = std::env::temp_dir().join(format!("refract-watch-state-wt-{session}"));
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::create_dir_all(&worktree).unwrap();

    let first = cached_worktree_validity(&session, &repo, &worktree).await;
    assert_eq!(first, WorktreeValidity::Invalid);
    // Mutate disk state that WOULD change the live answer (create a `.git` pointer) -- the
    // cached value must still be returned until the Session is forgotten/reset.
    std::fs::write(worktree.join(".git"), b"gitdir: ../../.git/worktrees/x\n").unwrap();
    let second = cached_worktree_validity(&session, &repo, &worktree).await;
    assert_eq!(
        second,
        WorktreeValidity::Invalid,
        "cache must not re-check until a reset"
    );
    forget_file_explorer_session(&session);
    // After forgetting, the cache is empty again (this test does not assert the NEW live value,
    // only that the slot was cleared) -- `cached_worktree_validity` would recompute on its next
    // call, proven by `VALIDITY_CACHE` no longer containing the key.
    assert!(!VALIDITY_CACHE.lock().unwrap().contains_key(&session));
}

#[test]
fn refresh_directory_guards_are_pure_and_callable() {
    // `refresh_directory` itself is private and exercised end-to-end by `ipc::file_explorer`'s
    // own live-check convention (CDP); this test only proves the pure `is_loaded` gate it leads
    // with behaves correctly for an unloaded path, which is the perf-critical guard (gate round
    // 1 Perf HIGH).
    let session = unique_session("refresh-guard");
    assert!(!is_loaded(&session, "node_modules/sub"));
    record_loaded_path(&session, "src");
    assert!(!is_loaded(&session, "node_modules/sub"));
    assert!(is_loaded(&session, "src"));
}
