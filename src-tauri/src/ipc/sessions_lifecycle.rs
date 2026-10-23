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
// `notify_file_explorer_reset` directly -- see each handler's own comment. Gate round 1 item 1
// (#464, Git changes panel): each of those same three handlers ALSO stops
// `fs::git_changes_watch_state`'s own separate per-Session watcher alongside the explorer one
// (that module has no tree/busy-session bookkeeping of its own, so it has nothing else to
// call here); `git_changes_watch_state::ensure_watcher` itself refuses to (re)start while
// `explorer_watch_state::is_session_busy` is true, reusing that same busy-claim rather than a
// second one.

use std::path::Path;

use serde_json::Value;

use crate::fs::leftover_summary::{cancel_and_wait, compute_leftover_summary};
use crate::git::git::GitError;
use crate::git::worktree_delete::remove_session_worktree;
use crate::git::worktree_delete_check::delete_check_for_session;
use crate::git::worktree_holders;
use crate::git::worktrees::{
    add_worktree_with_generated_name, branch_exists, list_branches, recreate_worktree,
    remove_worktree,
};
use crate::process::pid_records;
use crate::session::SessionStatus;
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
    d.register(
        "sessions.deleteLeftoverSummary",
        sessions_delete_leftover_summary,
    );
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
        // Gate round 1 item 1 (#464): the git-changes panel has its own, separate per-Session
        // watcher (`fs::git_changes_watch_state`) that `begin_worktree_operation` above knows
        // nothing about -- stop it here too, so a still-mounted panel's `ensureWatching` cannot
        // restart it mid-archive.
        crate::fs::git_changes_watch_state::stop_watcher(&id);
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
        // Issue #891 gate round 3 (H1): held for the whole `delete_check_for_session` call --
        // this spawns about five git child processes with their own `current_dir` set to the
        // worktree; `sessions.delete`'s own write guard blocks until this releases, so a Retry
        // can never start removing the worktree while a STALE `deleteCheck` call (the P4
        // post-refusal refresh) still has git children running with a cwd inside it.
        let _read_guard = crate::fs::worktree_access::read_guard(&id).await;
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

/// `sessions.deleteLeftoverSummary` (issue #891, Stuart's 2026-10-19 grill item 3): a
/// read-only background filesystem walk the Delete dialog runs as soon as it opens, listing
/// generated folders (for example `node_modules`) by name with file counts and other files by
/// path, capped with "and N more". Purely informational -- Delete stays enabled regardless of
/// how long this takes or what it finds; see `fs::leftover_summary`'s own header for why this
/// is deliberately a SEPARATE call from `sessions.deleteCheck`'s own fast git-only answer.
pub fn sessions_delete_leftover_summary(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match arg_str(&args, 0) {
            Some(id) => id.to_string(),
            None => {
                return Err(invalid_argument(
                    "sessions.deleteLeftoverSummary expects a string id",
                ))
            }
        };
        let session = {
            let registry = state.registry.lock().await;
            registry
                .get_session(&id)
                .ok_or_else(|| not_found(format!("Session not found: {id}")))?
                .clone()
        };
        let summary = compute_leftover_summary(&id, Path::new(&session.worktree_path)).await;
        Ok(serde_json::to_value(summary).expect("LeftoverSummary is always JSON-serialisable"))
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

        // Issue #891 gate round 1 item 5: a leftover-summary walk started when the dialog
        // opened may still be running against this exact worktree -- cancel it and wait for it
        // to actually exit BEFORE any holder check, so Refract's own open file handles during
        // "Checking files…" can never be mistaken for an external holder. A no-op if no walk
        // is currently in flight for this Session.
        cancel_and_wait(&id).await;

        // Issue #891 gate round 3 (H1): the write guard blocks until EVERY Refract-owned reader
        // of this worktree (`deleteCheck`'s own git children, the leftover walk above) has
        // released, and is held through the removal so no NEW reader can start. Issue #1055:
        // bounded (`write_guard_bounded`), so a hung reader yields an honest Retry refusal.
        let _write_guard = crate::fs::worktree_access::write_guard_bounded(&id)
            .await
            .map_err(map_git_error)?;

        // Issue #891, Stuart's 2026-10-19 grill item 2: the NAMED-holder (file-handle) check
        // runs BEFORE the agent is stopped -- a refused Delete for an external FILE holder must
        // leave the Session exactly as it was, agent still running, watcher untouched. This
        // Session's own recorded `omp` pids are excluded from whatever Restart Manager reports:
        // the agent itself holding its own files open is never a reason to refuse.
        let own_pids = pid_records::pids_for_session(&id).await;
        // Issue #891, Stuart's decision 2 (issuecomment-6273442096): a direct status read, not
        // `!own_pids.is_empty()` -- that list is only a proxy used to exclude this Session's
        // own pids from Restart Manager, and could in principle be stale (a crashed process
        // whose record has not yet been reaped) while the agent itself already reads `Stopped`.
        let was_running = state
            .session_manager
            .get_or_create_agent(&id)
            .status()
            .await
            != SessionStatus::Stopped;
        worktree_holders::check_named_holders(
            Path::new(&repository.path),
            Path::new(&session.worktree_path),
            &own_pids,
        )
        .await
        .map_err(map_git_error)?;

        // Lane R7 (#790) lifecycle hook, gate round 1/2 fixes: see `sessions_archive`'s own
        // comment -- resets on failure too, not only on success.
        let worktree_guard = crate::fs::explorer_watch_state::begin_worktree_operation(
            state.app_handle.clone(),
            &id,
        );
        // Gate round 1 item 1 (#464): see `sessions_archive`'s own comment -- stop the
        // git-changes panel's own separate watcher here too.
        crate::fs::git_changes_watch_state::stop_watcher(&id);
        // CRITICAL fix (gate round 1): the live agent (if any) must be shut down BEFORE the
        // worktree is removed -- same ordering `sessions.archive` uses. A still-running omp
        // process holds its cwd (and open file handles) inside the worktree; removing it out
        // from under a live process is the EBUSY/EPERM class `wrap_fs_error` exists to explain.
        // Also why the cwd-holder check below must come AFTER this, never before (see
        // `worktree_holders::check_folder_in_use`'s own doc comment): this Session's own agent,
        // while still running, is itself an unattributable cwd holder from a plain rename's own
        // point of view -- checking first would refuse every ordinary Delete of a running one.
        state
            .session_manager
            .get_or_create_agent(&id)
            .shutdown()
            .await;

        // Issue #891, Stuart's decision 2 (issuecomment-6273442096): "a refused Delete leaves
        // the Session running" stands even here. If the probe refuses and the agent WAS
        // running before this call (`was_running`, captured above -- Delete's own shutdown is
        // the only reason it would not be), restart it through the normal `start()` path before
        // returning the refusal; a Session already stopped beforehand stays stopped, matching
        // every other refusal. A restart failure must never hide the real one: `status()` is
        // checked afterwards (same pattern `ipc/sessions_agent.rs`'s own `resume_session_core`
        // uses), and if it is still `Stopped` the returned message names that too.
        if let Err(err) = worktree_holders::check_folder_in_use(
            Path::new(&repository.path),
            Path::new(&session.worktree_path),
            &id,
            &own_pids,
        )
        .await
        {
            let code = err.code;
            let mut message = err.message;
            if was_running {
                let agent = state.session_manager.get_or_create_agent(&id);
                let _ = agent.start().await;
                if agent.status().await == SessionStatus::Stopped {
                    message = format!(
                        "{message} Also, Refract could not restart this Session's agent automatically -- reopen it yourself."
                    );
                }
            }
            return Err(map_git_error(GitError::new(code, message)));
        }

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
        // Gate round 1 item 1 (#464): see `sessions_archive`'s own comment -- stop the
        // git-changes panel's own separate watcher here too.
        crate::fs::git_changes_watch_state::stop_watcher(&id);
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

// Split into `sessions_delete_support.rs` (#806 "No god files", issue #891 gate round 1 margin):
// the reclaim hook, the Conversation-cleanup helper, and its own path-containment check.
mod sessions_delete_support;
#[cfg(test)]
use sessions_delete_support::WORKTREE_RELEASED_HOOK_CALLS;
use sessions_delete_support::{
    delete_session_conversations, is_strict_descendant_of_omp_sessions, on_worktree_released,
};

#[cfg(test)]
#[path = "sessions_lifecycle_tests.rs"]
mod tests;
