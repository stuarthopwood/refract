// Registry-only `sessions.*` handlers: list, create, rename, archive, restore, delete, recreate, diffStat.
// Split from `sessions.rs` (#784); `.open`/`.stopAgent`/`.setVisible` live in `sessions_agent.rs`.

use std::path::Path;

use serde_json::Value;

use crate::fs::leftover_summary::compute_leftover_summary;
use crate::git::git::GitError;
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
    d.register("sessions.deleting", sessions_deleting);
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
                .ok_or_else(|| not_found(format!("Project not found: {repository_id}")))?
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
            hidden_at: None,
            paused_held: None,
            current_turn_subagents: None,
            stopped_on_request_conversation: None,
            stopped_on_request_at_size: None,
            pinned_model: false,
            origin_issue: None,
            parent_session_id: None,
        };

        if let Err(err) = state
            .registry
            .lock()
            .await
            .add_session(session.clone())
            .await
        {
            // Roll back the new worktree if the Repository was removed mid-create.
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
        delete_in_flight::refuse_if_deleting(&id)?;
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

/// `sessions.archive`: stops the live agent if any, then stamps `archivedAt`.
pub fn sessions_archive(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match arg_str(&args, 0) {
            Some(id) => id.to_string(),
            None => return Err(invalid_argument("sessions.archive expects a string id")),
        };
        delete_in_flight::refuse_if_deleting(&id)?;
        if state.registry.lock().await.get_session(&id).is_none() {
            return Err(not_found(format!("Session not found: {id}")));
        }
        // Mark busy before archiving so a concurrent watcher restart cannot race the operation.
        // The Explorer is reset on success and failure so it never shows a stale tree.
        let worktree_guard = crate::fs::explorer_watch_state::begin_worktree_operation(
            state.app_handle.clone(),
            &id,
        );
        // The git-changes watcher is separate from `begin_worktree_operation`; stop it too (#464).
        crate::fs::git_changes_watch_state::stop_watcher(&id);
        state
            .session_manager
            .get_or_create_agent(&id)
            .shutdown()
            .await;
        // Clears any stale pid record.
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
        // Disk-reclaim hook for archived worktrees (#657, #658). Fires only on success.
        on_worktree_released(&id);
        worktree_guard.finish(crate::fs::explorer_watch_state::WorktreeOperationOutcome::Reset);
        state.session_manager.notify_list_changed();
        Ok(Value::Null)
    })
}

/// `sessions.restore`: clears `archivedAt`.
pub fn sessions_restore(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match arg_str(&args, 0) {
            Some(id) => id.to_string(),
            None => return Err(invalid_argument("sessions.restore expects a string id")),
        };
        delete_in_flight::refuse_if_deleting(&id)?;
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
        // Reset the Explorer, which may still show the archived state.
        crate::fs::explorer_watch_state::notify_file_explorer_reset(&state.app_handle, &id);
        state.session_manager.notify_list_changed();
        Ok(Value::Null)
    })
}

/// `sessions.deleteCheck`: feeds the delete confirmation. Decides from git state, never `fs.stat`.
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
                .ok_or_else(|| not_found(format!("Project not found: {}", session.repository_id)))?
                .clone();
            (session, repository)
        };
        // Held across the git calls, so a Retry cannot remove the worktree under them (#891).
        let _read_guard = crate::fs::worktree_access::read_guard_bounded(&id)
            .await
            .map_err(map_git_error)?;
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

/// `sessions.deleteLeftoverSummary`: informational walk of leftover files for the Delete dialog.
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

/// `sessions.deleting`: ids whose removal is still running, so a reloaded renderer can re-mark them.
pub fn sessions_deleting(_state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move { Ok(Value::from(delete_in_flight::deleting_ids())) })
}

/// `sessions.delete`: runs every refusal check, then removes the worktree, its Conversation files
/// and the registry entry in the background; the outcome arrives as an event.
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
        delete_in_flight::refuse_if_deleting(&id)?;
        let (session, repository) = {
            let registry = state.registry.lock().await;
            let session = registry
                .get_session(&id)
                .ok_or_else(|| not_found(format!("Session not found: {id}")))?
                .clone();
            let repository = registry
                .get_repository(&session.repository_id)
                .ok_or_else(|| not_found(format!("Project not found: {}", session.repository_id)))?
                .clone();
            (session, repository)
        };

        // Cancel the leftover walk first so Refract's own handles are not read as external holders.
        crate::fs::worktree_access::cancel_walk_bounded(&id)
            .await
            .map_err(map_git_error)?;

        // Held through removal so no new reader starts (#1055); the background task takes it over.
        let write_guard = crate::fs::worktree_access::write_guard_bounded(&id)
            .await
            .map_err(map_git_error)?;

        // Check named file holders before stopping the agent, so a refusal changes nothing. Own pids are excluded.
        let own_pids = pid_records::pids_for_session(&id).await;
        // Read the status directly; the own-pids list can be stale after a crash.
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

        // Claimed once the refusals that leave the Session untouched pass, so other handlers refuse
        // for the whole destructive phase; dropping the claim on any error path unmarks it.
        let claim = delete_in_flight::claim(&id)?;
        // Resets the Explorer on failure too (see `sessions_archive`).
        let worktree_guard = crate::fs::explorer_watch_state::begin_worktree_operation(
            state.app_handle.clone(),
            &id,
        );
        // Stop the git-changes panel's separate watcher too (#464).
        crate::fs::git_changes_watch_state::stop_watcher(&id);
        // Shut the agent down before removal: a live process holds the worktree's cwd.
        // The cwd-holder check must run after this, or it refuses every Delete of a running Session.
        state
            .session_manager
            .get_or_create_agent(&id)
            .shutdown()
            .await;

        // A refused Delete restarts a Session that was running before the call (#891).
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
                let _ = agent.start_unchecked().await;
                if agent.status().await == SessionStatus::Stopped {
                    message = format!(
                        "{message} Also, Refract could not restart this Session's agent automatically -- reopen it yourself."
                    );
                }
            }
            return Err(map_git_error(GitError::new(code, message)));
        }

        crate::process::pid_records::remove_process_records_for_session(&id).await;

        delete_in_flight::start(
            state,
            session,
            repository,
            write_guard,
            worktree_guard,
            claim,
        );
        Ok(Value::Null)
    })
}

/// `sessions.recreateWorktree`: recreates the worktree at its path on the existing branch.
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
        delete_in_flight::refuse_if_deleting(&id)?;
        let (session, repository) = {
            let registry = state.registry.lock().await;
            let session = registry
                .get_session(&id)
                .ok_or_else(|| not_found(format!("Session not found: {id}")))?
                .clone();
            let repository = registry
                .get_repository(&session.repository_id)
                .ok_or_else(|| not_found(format!("Project not found: {}", session.repository_id)))?
                .clone();
            (session, repository)
        };

        // Take the busy claim after `branch_exists`, so a branch-missing failure leaves the watcher running.
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
        // Stop the git-changes panel's separate watcher too (#464).
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

// Delete helpers (reclaim hook, Conversation cleanup, path check) live in `sessions_delete_support.rs`.
mod sessions_delete_support;
use sessions_delete_support::on_worktree_released;
#[cfg(test)]
use sessions_delete_support::{
    delete_session_conversations, is_strict_descendant_of_omp_sessions,
    WORKTREE_RELEASED_HOOK_CALLS,
};

// The background half of `sessions.delete`: in-flight set and the spawned removal.
pub(crate) mod delete_in_flight;

#[cfg(test)]
#[path = "sessions_lifecycle_tests.rs"]
mod tests;
