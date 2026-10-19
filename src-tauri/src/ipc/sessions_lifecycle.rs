// IPC handlers for the registry-only `sessions.*` subset (contracts/ipc.md "Sessions", tasks.md
// T019/T024/T041/T042/T043/T068): `.list`/`.create`/`.rename` (Phase 2(b)), `.archive`/
// `.restore` (T041), `.deleteCheck`/`.delete` (T042), `.recreateWorktree` (T043), and
// `.diffStat`/`.revealWorktree` (T068, lane R2 #785). `.list` now completes its live-runtime
// fields via `session::SessionManager::summaries` (Phase 3, tasks.md T024) instead of the "never
// opened this run" default placeholder.
//
// Split from the former `ipc/sessions.rs` (issue #784, "Pre-declare per-lane Rust files") so
// lane R2 (#785, session worktree and lifecycle: archive, restore, delete, recreate, diffStat,
// reveal, remotes) is the only lane that ever edits this file; `.open`/`.stopAgent`/
// `.setVisible` live in the sibling `ipc/sessions_agent.rs` instead (lane R3, #786).
//
// Simplification from `sessions.ts` (lane R3/#786 territory, not built yet in this crate): no
// `resumingIds` busy-lock exists here, so `.archive`/`.delete` skip the guard against a
// concurrent `sessions.resume` (lane R3's own channel). The file-explorer watcher
// lifecycle wiring (lane R7, #790, gate round 1 fix) IS now in place: `.archive`/`.delete`/
// `.recreateWorktree` each call `fs::explorer_watch_state::begin_worktree_operation` before
// touching the worktree and `.finish(...)` after, and `.restore` calls
// `notify_file_explorer_reset` directly -- see each handler's own comment.

use std::path::Path;

use serde_json::Value;

use crate::git::worktree_delete::remove_session_worktree;
use crate::git::worktree_delete_check::delete_check_for_session;
use crate::git::worktree_validity::comparable_path;
use crate::git::worktrees::{
    add_worktree_with_generated_name, branch_exists, list_branches, recreate_worktree,
    remove_worktree,
};
use crate::store::registry::{Session, SessionPatch};

use super::{
    arg_str, invalid_argument, map_git_error, map_registry_error, not_found, now_iso8601, AppState,
    Dispatcher, HandlerFuture, IpcError,
};

pub fn register(d: &mut Dispatcher) {
    d.register("sessions.list", sessions_list);
    d.register("sessions.create", sessions_create);
    d.register("sessions.rename", sessions_rename);
    d.register("sessions.archive", sessions_archive);
    d.register("sessions.restore", sessions_restore);
    d.register("sessions.deleteCheck", sessions_delete_check);
    d.register("sessions.delete", sessions_delete);
    d.register("sessions.recreateWorktree", sessions_recreate_worktree);
    d.register("sessions.diffStat", sessions_diff_stat);
    d.register("sessions.revealWorktree", sessions_reveal_worktree);
}

pub fn sessions_list(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move { Ok(Value::Array(state.session_manager.summaries().await)) })
}

pub fn sessions_create(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let input = match args.first().and_then(Value::as_object) {
            Some(input) => input,
            None => {
                return Err(invalid_argument(
                    "sessions.create expects { repositoryId, baseBranch }",
                ))
            }
        };
        let repository_id = match input.get("repositoryId").and_then(Value::as_str) {
            Some(id) => id.to_string(),
            None => {
                return Err(invalid_argument(
                    "sessions.create expects { repositoryId: string, baseBranch: string }",
                ))
            }
        };
        let base_branch = match input.get("baseBranch").and_then(Value::as_str) {
            Some(branch) => branch.to_string(),
            None => {
                return Err(invalid_argument(
                    "sessions.create expects { repositoryId: string, baseBranch: string }",
                ))
            }
        };

        let repository = {
            let registry = state.registry.lock().await;
            registry
                .get_repository(&repository_id)
                .ok_or_else(|| not_found(format!("Repository not found: {repository_id}")))?
                .clone()
        };
        let repo_path = std::path::Path::new(&repository.path);

        let branches = list_branches(repo_path).await.map_err(map_git_error)?;
        if !branches.iter().any(|b| b == &base_branch) {
            return Err(super::IpcError::new(
                "base-missing",
                format!("Base branch not found: {base_branch}"),
            ));
        }

        let added = add_worktree_with_generated_name(repo_path, &base_branch)
            .await
            .map_err(map_git_error)?;
        let now = now_iso8601();
        let session = Session {
            id: uuid::Uuid::new_v4().to_string(),
            repository_id: repository_id.clone(),
            name: added.branch.clone(),
            branch: added.branch.clone(),
            base_branch,
            worktree_path: added.worktree_path.to_string_lossy().into_owned(),
            session_dir: None,
            current_conversation: None,
            last_message_count: None,
            last_model: None,
            last_thinking_level: None,
            created_at: now.clone(),
            last_activity_at: now,
            archived_at: None,
            current_turn_subagents: None,
            stopped_on_request_conversation: None,
            stopped_on_request_at_size: None,
            pinned_model: false,
        };

        if let Err(err) = state
            .registry
            .lock()
            .await
            .add_session(session.clone())
            .await
        {
            // Security remediation (Medium, ported from `sessions.ts`): the Repository may have
            // been removed while `list_branches`/`add_worktree_with_generated_name` above were
            // still in flight -- roll back the worktree/branch just created so it is not
            // stranded.
            let _ = remove_worktree(repo_path, &added.worktree_path, &added.branch, true).await;
            return Err(map_registry_error(err));
        }

        Ok(serde_json::to_value(session).expect("Session is always JSON-serialisable"))
    })
}

pub fn sessions_rename(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match args.first().and_then(Value::as_str) {
            Some(id) => id.to_string(),
            None => {
                return Err(invalid_argument(
                    "sessions.rename expects (id, name) strings",
                ))
            }
        };
        let name = match args.get(1).and_then(Value::as_str) {
            Some(name) => name.to_string(),
            None => {
                return Err(invalid_argument(
                    "sessions.rename expects (id, name) strings",
                ))
            }
        };
        state
            .registry
            .lock()
            .await
            .update_session_name(&id, name)
            .await
            .map_err(map_registry_error)?;
        Ok(Value::Null)
    })
}

/// `sessions.archive` (T041): stops the live agent (if any -- idempotent for an already-stopped
/// Session, same as `SessionAgent::shutdown`'s own contract), then stamps `archivedAt`. See this
/// file's header for the `resumingIds`/file-explorer simplifications ported out of
/// `sessions.ts`'s own handler.
pub fn sessions_archive(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match arg_str(&args, 0) {
            Some(id) => id.to_string(),
            None => return Err(invalid_argument("sessions.archive expects a string id")),
        };
        if state.registry.lock().await.get_session(&id).is_none() {
            return Err(not_found(format!("Session not found: {id}")));
        }
        // Lane R7 (#790) lifecycle hook, gate round 1/2 fixes: stops any running file-explorer
        // watcher and marks the Session busy BEFORE the archive proceeds, so a concurrent
        // `listDirectory`/`ensureWatching` cannot restart one mid-operation; resets the Explorer
        // on BOTH success and failure (the watcher is already stopped either way) so a mounted
        // panel re-checks instead of staying on a stale tree with no watcher underneath
        // (`sessions.ts`:209, 228-234).
        let worktree_guard = crate::fs::explorer_watch_state::begin_worktree_operation(
            state.app_handle.clone(),
            &id,
        );
        state
            .session_manager
            .get_or_create_agent(&id)
            .shutdown()
            .await;
        // Gate-fix (security MEDIUM, round 6): clears any stale pid record (own doc comment).
        crate::process::pid_records::remove_process_records_for_session(&id).await;
        state
            .registry
            .lock()
            .await
            .update_session(
                &id,
                SessionPatch {
                    archived_at: Some(Some(now_iso8601())),
                    ..Default::default()
                },
            )
            .await
            .map_err(map_registry_error)?;
        // Issue #657/#658 (disk hygiene on archive and PR merge): the single call point future
        // reclaim logic attaches to once an archived Session's worktree becomes eligible for
        // GC -- the actual POLICY (whether/when to reclaim) stays deferred to those issues;
        // this hook only ships the point itself, so a later lane never has to rediscover where
        // archive finishes. Fires only on success, never on an early `?` return above.
        on_worktree_released(&id);
        worktree_guard.finish(crate::fs::explorer_watch_state::WorktreeOperationOutcome::Reset);
        state.session_manager.notify_list_changed();
        Ok(Value::Null)
    })
}

/// `sessions.restore` (T041): clears `archivedAt` back to `null`.
pub fn sessions_restore(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match arg_str(&args, 0) {
            Some(id) => id.to_string(),
            None => return Err(invalid_argument("sessions.restore expects a string id")),
        };
        if state.registry.lock().await.get_session(&id).is_none() {
            return Err(not_found(format!("Session not found: {id}")));
        }
        state
            .registry
            .lock()
            .await
            .update_session(
                &id,
                SessionPatch {
                    archived_at: Some(None),
                    ..Default::default()
                },
            )
            .await
            .map_err(map_registry_error)?;
        // Lane R7 (#790) lifecycle hook: a mounted Explorer panel for this Session was stuck on
        // the "archived" state -- reset so it re-checks and reloads now that it is live again.
        crate::fs::explorer_watch_state::notify_file_explorer_reset(&state.app_handle, &id);
        state.session_manager.notify_list_changed();
        Ok(Value::Null)
    })
}

/// `sessions.deleteCheck` (T042): feeds the delete confirmation text. Issue #599 (see
/// `git::worktree_delete`'s own header): decides purely from live git state, never `fs.stat`ing
/// the worktree folder.
pub fn sessions_delete_check(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match arg_str(&args, 0) {
            Some(id) => id.to_string(),
            None => return Err(invalid_argument("sessions.deleteCheck expects a string id")),
        };
        let (session, repository) = {
            let registry = state.registry.lock().await;
            let session = registry
                .get_session(&id)
                .ok_or_else(|| not_found(format!("Session not found: {id}")))?
                .clone();
            let repository = registry
                .get_repository(&session.repository_id)
                .ok_or_else(|| {
                    not_found(format!("Repository not found: {}", session.repository_id))
                })?
                .clone();
            (session, repository)
        };
        let check = delete_check_for_session(
            Path::new(&repository.path),
            Path::new(&session.worktree_path),
            &session.branch,
        )
        .await
        .map_err(map_git_error)?;
        Ok(serde_json::to_value(check).expect("DeleteCheck is always JSON-serialisable"))
    })
}

/// `sessions.delete` (T042): removes the worktree (issue #599's safe-delete path), best-effort
/// deletes this Session's own Conversation transcript files, then removes the registry entry.
/// See this file's header for the `resumingIds`/file-explorer simplifications.
pub fn sessions_delete(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match arg_str(&args, 0) {
            Some(id) => id.to_string(),
            None => {
                return Err(invalid_argument(
                    "sessions.delete expects (id, { confirmed })",
                ))
            }
        };
        let options = match args.get(1).and_then(Value::as_object) {
            Some(options) => options,
            None => {
                return Err(invalid_argument(
                    "sessions.delete expects (id, { confirmed })",
                ))
            }
        };
        if options.get("confirmed").and_then(Value::as_bool) != Some(true) {
            return Err(invalid_argument(
                "sessions.delete requires { confirmed: true }",
            ));
        }
        let (session, repository) = {
            let registry = state.registry.lock().await;
            let session = registry
                .get_session(&id)
                .ok_or_else(|| not_found(format!("Session not found: {id}")))?
                .clone();
            let repository = registry
                .get_repository(&session.repository_id)
                .ok_or_else(|| {
                    not_found(format!("Repository not found: {}", session.repository_id))
                })?
                .clone();
            (session, repository)
        };

        // Lane R7 (#790) lifecycle hook, gate round 1/2 fixes: see `sessions_archive`'s own
        // comment -- resets on failure too, not only on success.
        let worktree_guard = crate::fs::explorer_watch_state::begin_worktree_operation(
            state.app_handle.clone(),
            &id,
        );
        // CRITICAL fix (gate round 1): the live agent (if any) must be shut down BEFORE the
        // worktree is removed -- same ordering `sessions.archive` already uses, same ordering
        // `sessions.ts`'s own SESSIONS_DELETE handler uses (`await manager.getOrCreateAgent(id)
        // .shutdown()` before `removeSessionWorktree`). A still-running omp process holds its
        // cwd (and open file handles) inside the worktree; removing it out from under a live
        // process is exactly the EBUSY/EPERM class `git::worktree_delete`'s own `wrap_fs_error`
        // exists to explain, not something this handler should ever risk causing.
        state
            .session_manager
            .get_or_create_agent(&id)
            .shutdown()
            .await;
        crate::process::pid_records::remove_process_records_for_session(&id).await;

        remove_session_worktree(
            Path::new(&repository.path),
            Path::new(&session.worktree_path),
            &session.branch,
            true,
        )
        .await
        .map_err(map_git_error)?;

        if let Some(session_dir) = &session.session_dir {
            if is_strict_descendant_of_omp_sessions(session_dir) {
                delete_session_conversations(session_dir).await;
            } else {
                log::warn!(
                    "sessions.delete: refusing to delete sessionDir outside ~/.omp/agent/sessions: {session_dir}"
                );
            }
        }

        state
            .registry
            .lock()
            .await
            .remove_session(&id)
            .await
            .map_err(map_registry_error)?;
        state.session_manager.remove_agent(&id);
        // Gate round 2 (D2-rev Sec2 Medium): drops this Session's own absolute-path allow-list
        // entry (`file_attachments.rs`'s own `ALLOWED_PATHS_STORE`) now that it is truly gone,
        // so that process-wide map never accumulates one stale entry per Session ever deleted.
        super::file_attachments::forget_session(&id);
        // Issue #657/#658: same reclaim hook `sessions_archive` fires, called here too since
        // delete releases a worktree exactly as finally as an archive does. Fires only on
        // success (every earlier failure path returns via `?` before reaching this line).
        on_worktree_released(&id);
        worktree_guard.finish(crate::fs::explorer_watch_state::WorktreeOperationOutcome::Forgotten);
        state.session_manager.notify_list_changed();
        Ok(Value::Null)
    })
}

/// `sessions.recreateWorktree` (T043): recreates the worktree at its original path, attaching
/// the existing branch. `branch-missing` is this handler's own custom error (not a `GitError`),
/// matching `sessions.ts`'s own handler.
pub fn sessions_recreate_worktree(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match arg_str(&args, 0) {
            Some(id) => id.to_string(),
            None => {
                return Err(invalid_argument(
                    "sessions.recreateWorktree expects a string id",
                ))
            }
        };
        let (session, repository) = {
            let registry = state.registry.lock().await;
            let session = registry
                .get_session(&id)
                .ok_or_else(|| not_found(format!("Session not found: {id}")))?
                .clone();
            let repository = registry
                .get_repository(&session.repository_id)
                .ok_or_else(|| {
                    not_found(format!("Repository not found: {}", session.repository_id))
                })?
                .clone();
            (session, repository)
        };

        // Lane R7 (#790) lifecycle hook, gate round 1/2 fixes: the busy/stop claim is taken
        // AFTER `branch_exists` (not before, gate round 2 fix) -- Electron's own
        // `recreateWorktree` only stops the watcher once it knows the branch actually exists,
        // so a plain `branch-missing` failure (no worktree mutation attempted at all) never
        // stops a healthy running watcher for no reason. Once taken, it resets the Explorer on
        // BOTH success and a later failure (the watcher is already stopped before the folder
        // recreation is attempted, same PR #671 round 4 Critical reasoning as before).
        let repo_path = Path::new(&repository.path);
        if !branch_exists(repo_path, &session.branch).await {
            return Err(IpcError::new(
                "branch-missing",
                format!("Branch not found: {}", session.branch),
            ));
        }
        let worktree_guard = crate::fs::explorer_watch_state::begin_worktree_operation(
            state.app_handle.clone(),
            &id,
        );
        recreate_worktree(
            repo_path,
            Path::new(&session.worktree_path),
            &session.branch,
        )
        .await
        .map_err(map_git_error)?;
        worktree_guard.finish(crate::fs::explorer_watch_state::WorktreeOperationOutcome::Reset);
        state.session_manager.notify_list_changed();
        Ok(Value::Null)
    })
}

mod diag;
use diag::{sessions_diff_stat, sessions_reveal_worktree};

/// Issues #657/#658 (gate round 2: a reviewer found this bullet in #785 asks only for a call
/// point plus a test, never the 5-slice reclaim POLICY those two issues themselves scope --
/// this hook is exactly that call point, nothing more): the single place future worktree/branch
/// reclaim logic for a Session whose worktree is no longer needed (archived, or deleted)
/// attaches to, so a later lane implementing #657's slice 1 or #658's reap step never has to
/// rediscover where `sessions.archive`/`sessions.delete` finish releasing a worktree. A no-op
/// today -- the decision on WHETHER/WHEN to reclaim stays with #657/#658, not this lane.
fn on_worktree_released(_session_id: &str) {
    #[cfg(test)]
    WORKTREE_RELEASED_HOOK_CALLS.with(|calls| calls.set(calls.get() + 1));
}

// Thread-local, not a global atomic (gate round 2): `#[tokio::test]`'s default current-thread
// runtime keeps one whole test's execution on a single OS thread from start to finish, and the
// std test harness never runs two different tests concurrently on that SAME thread -- so a
// thread-local counter isolates each test's own "did the hook fire" observation from every
// OTHER test running in parallel on a different thread, which a single process-wide atomic
// could not (a concurrently running, unrelated archive/delete call firing the hook would have
// made a "never fires on failure" assertion flaky).
#[cfg(test)]
thread_local! {
    static WORKTREE_RELEASED_HOOK_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Security: a Session's `session_dir` is learned from OMP's own `get_state`, but the registry
/// is just a JSON file -- a corrupted or hand-edited one must never make `sessions.delete`
/// remove an arbitrary path. Only a true descendant of the real OMP sessions root (never the
/// root itself) is ever touched. Mirrors `sessions.ts`'s own `isStrictDescendantOfOmpSessions`;
/// `dirs::home_dir()` is the same home-directory resolution `omp/process.rs` already uses for
/// `~/.omp/logs`, and `comparable_path` is the same lexical-resolve-plus-lowercase comparison
/// key `git::worktree_validity`/`store::registry` already use for a path that may not (yet)
/// exist on disk.
fn is_strict_descendant_of_omp_sessions(dir: &str) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let sessions_root = comparable_path(
        &home
            .join(".omp")
            .join("agent")
            .join("sessions")
            .to_string_lossy(),
    );
    let resolved = comparable_path(dir);
    resolved != sessions_root
        && resolved.starts_with(&format!("{sessions_root}{}", std::path::MAIN_SEPARATOR))
}

/// Deletes only this Session's own Conversation files (`*.jsonl`) and their sibling same-stem
/// directories (subagent transcripts, data-model.md), then removes `session_dir` itself only
/// once it is empty -- never a wholesale recursive remove, which could take unrelated sibling
/// Conversations or (if `session_dir` were ever wrong) far more than that. Best-effort
/// throughout (mirrors `sessions.ts`'s own `deleteSessionConversations`): every removal failure
/// is swallowed, since a Session that could not fully clean up its own transcript files still
/// must finish being deleted from the registry.
async fn delete_session_conversations(session_dir: &str) {
    let dir = Path::new(session_dir);
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(_) => return,
    };
    let mut names = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        names.push(entry.file_name());
    }
    for name in names {
        let name = name.to_string_lossy().into_owned();
        if !name.to_lowercase().ends_with(".jsonl") {
            continue;
        }
        let file_path = dir.join(&name);
        let sibling_dir = dir.join(&name[..name.len() - ".jsonl".len()]);
        let _ = tokio::fs::remove_file(&file_path).await;
        let _ = tokio::fs::remove_dir_all(&sibling_dir).await;
    }
    if let Ok(mut remaining) = tokio::fs::read_dir(dir).await {
        if matches!(remaining.next_entry().await, Ok(None)) {
            let _ = tokio::fs::remove_dir(dir).await;
        }
    }
}

#[cfg(test)]
#[path = "sessions_lifecycle_tests.rs"]
mod tests;
