// Test module for `explorer_watch_state.rs`, split into this sibling file to stay under the
// 600-line soft cap -- included via `#[path = "explorer_watch_state_tests.rs"] mod tests;`.

use super::*;

fn unique_session(label: &str) -> String {
    format!("{label}-{}", uuid::Uuid::new_v4())
}

fn no_app_handle() -> Arc<StdMutex<Option<AppHandle>>> {
    Arc::new(StdMutex::new(None))
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
    assert_eq!(busy_count(&session), 2);
    unmark_session_busy(&session);
    assert!(is_session_busy(&session));
    assert_eq!(busy_count(&session), 1);
    unmark_session_busy(&session);
    assert!(!is_session_busy(&session));
    assert_eq!(busy_count(&session), 0);
}

#[test]
fn begin_worktree_operation_clears_busy_on_drop_without_finish() {
    let session = unique_session("guard-drop");
    let resets: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));
    {
        let _guard = begin_worktree_operation(no_app_handle(), &session);
        assert!(is_session_busy(&session));
    }
    // Gate round 2 fix: dropped without `finish()` (the early-`?`-return / failure path) must
    // still clear busy AND reset -- a failed lifecycle operation already stopped the watcher, so
    // a mounted panel must still re-check rather than being left on a stale tree with none.
    assert!(!is_session_busy(&session));
    let _ = resets; // no real AppHandle in this test to observe the emitted event through; the
                    // "does it reset" behaviour is covered live (CDP) and by the handle-present
                    // variant below via `has_loaded_paths` clearing.
}

#[test]
fn begin_worktree_operation_drop_without_finish_forgets_loaded_paths_via_reset() {
    let session = unique_session("guard-drop-forgets");
    record_loaded_path(&session, "sub");
    {
        let _guard = begin_worktree_operation(no_app_handle(), &session);
    }
    // `notify_file_explorer_reset` (fired by Drop on the failure path) clears loaded paths --
    // observable proof the reset path actually ran, without needing a real `AppHandle`.
    assert!(!has_loaded_paths(&session));
}

#[test]
fn begin_worktree_operation_finish_clears_busy_and_forgets() {
    let session = unique_session("guard-finish");
    record_loaded_path(&session, "sub");
    let guard = begin_worktree_operation(no_app_handle(), &session);
    assert!(is_session_busy(&session));
    guard.finish(WorktreeOperationOutcome::Forgotten);
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
    ensure_watcher(runtime, no_app_handle(), None, &session, &dir, None, false);
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
            ensure_watcher(runtime, no_app_handle(), None, &session, &dir, None, false);
        });
    }
    while set.join_next().await.is_some() {}

    // Gate round 2 fix: assert exactly one SURVIVING handle, not just "a watcher exists" --
    // capture its identity, then prove a THIRD `ensure_watcher` call (now a plain no-op since a
    // watcher already exists) returns the SAME handle rather than silently replacing it.
    let first_handle = watcher_handle(&session).expect("exactly one watcher must survive the race");
    ensure_watcher(runtime, no_app_handle(), None, &session, &dir, None, false);
    assert!(
        watcher_matches(&session, &first_handle),
        "a third call must not replace the surviving handle"
    );
    stop_file_explorer_watcher(&session);
    assert!(!has_watcher(&session));
}

#[tokio::test]
async fn cached_worktree_validity_caches_only_valid_until_a_reset() {
    let session = unique_session("validity-valid");
    let repo = crate::git::test_support::init_repo().await;
    let worktree = repo.with_file_name(format!("wt-{}", uuid::Uuid::new_v4()));
    crate::git::test_support::run_git(
        &repo,
        &[
            "worktree",
            "add",
            "-b",
            &format!("branch-{session}"),
            worktree.to_str().unwrap(),
            "main",
        ],
    )
    .await;

    let first = cached_worktree_validity(&session, &repo, &worktree).await;
    assert_eq!(first, WorktreeValidity::Valid);

    // Mutate disk state that WOULD change the live answer (remove the `.git` pointer file) --
    // the CACHED `Valid` value must still be returned until a reset/forget.
    std::fs::remove_file(worktree.join(".git")).unwrap();
    let second = cached_worktree_validity(&session, &repo, &worktree).await;
    assert_eq!(
        second,
        WorktreeValidity::Valid,
        "a cached Valid result must not re-check until a reset"
    );

    forget_file_explorer_session(&session);
    assert!(!VALIDITY_CACHE.lock().unwrap().contains_key(&session));

    // Cache slot cleared: the live (now genuinely Invalid, since `.git` is gone) answer returns.
    let third = cached_worktree_validity(&session, &repo, &worktree).await;
    assert_eq!(third, WorktreeValidity::Invalid);
}

#[tokio::test]
async fn cached_worktree_validity_never_caches_an_invalid_result() {
    // Gate round 2 fix: an `Invalid` answer must NEVER be cached, so a user who repairs a broken
    // worktree outside the app and hits Retry always sees the live, current answer.
    let session = unique_session("validity-invalid");
    let repo = std::env::temp_dir().join(format!("refract-watch-state-repo-{session}"));
    let worktree = std::env::temp_dir().join(format!("refract-watch-state-wt-{session}"));
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::create_dir_all(&worktree).unwrap();

    let first = cached_worktree_validity(&session, &repo, &worktree).await;
    assert_eq!(first, WorktreeValidity::Invalid);
    assert!(
        !VALIDITY_CACHE.lock().unwrap().contains_key(&session),
        "an Invalid result must never be cached"
    );
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
