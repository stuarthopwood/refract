// Registry-only `sessions.*` handlers: list, create, rename, archive, restore, delete, recreate, diffStat.
// Split from `sessions.rs` (#784); `.open`/`.stopAgent`/`.setVisible` live in `sessions_agent.rs`.

use std::path::Path;

use serde_json::Value;

use crate::fs::leftover_summary::compute_leftover_summary;
use crate::git::worktree_delete_check::delete_check_for_session;
use crate::git::worktrees::{
    add_worktree_with_generated_name, branch_exists, list_branches, recreate_worktree,
    remove_worktree,
};
use crate::session::agent::SharedRegistry;
use crate::store::registry::Session;
use crate::store::session_kind::SessionKind;

use super::project_session::{project_binding, refuse_if_personal, repo_binding};
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

        let session =
            create_session_record(&state.registry, &repository_id, &base_branch, None).await?;
        Ok(serde_json::to_value(session).expect("Session is always JSON-serialisable"))
    })
}

/// The Worktree and registry steps of making a Session, shared by `sessions.create` and the
/// agent's `refract_create_session`. The Worktree is removed again if the registry refuses the row.
pub(crate) async fn create_session_record(
    registry: &SharedRegistry,
    repository_id: &str,
    base_branch: &str,
    parent_session_id: Option<String>,
) -> Result<Session, IpcError> {
    insert_session(
        registry,
        repository_id,
        base_branch,
        parent_session_id,
        true,
    )
    .await
}

/// As `create_session_record` for a caller that has just listed the branches itself, so the
/// agent tool does not list them a second time while holding the tree gate. A base deleted since
/// then fails in `git worktree add` instead.
pub(crate) async fn create_session_record_on_listed_base(
    registry: &SharedRegistry,
    repository_id: &str,
    base_branch: &str,
    parent_session_id: Option<String>,
) -> Result<Session, IpcError> {
    insert_session(
        registry,
        repository_id,
        base_branch,
        parent_session_id,
        false,
    )
    .await
}

async fn insert_session(
    registry: &SharedRegistry,
    repository_id: &str,
    base_branch: &str,
    parent_session_id: Option<String>,
    verify_base: bool,
) -> Result<Session, IpcError> {
    let repository = {
        let registry = registry.lock().await;
        registry
            .get_repository(repository_id)
            .ok_or_else(|| not_found(format!("Project not found: {repository_id}")))?
            .clone()
    };
    let repo_path = std::path::Path::new(&repository.path);

    if verify_base {
        let branches = list_branches(repo_path).await.map_err(map_git_error)?;
        if !branches.iter().any(|b| b == base_branch) {
            return Err(IpcError::new(
                "base-missing",
                format!("Base branch not found: {base_branch}"),
            ));
        }
    }
    let added = add_worktree_with_generated_name(repo_path, base_branch)
        .await
        .map_err(map_git_error)?;
    let now = now_iso8601();
    let session = Session {
        id: uuid::Uuid::new_v4().to_string(),
        kind: SessionKind::Project,
        repository_id: Some(repository_id.to_string()),
        name: added.branch.clone(),
        branch: Some(added.branch.clone()),
        base_branch: Some(base_branch.to_string()),
        worktree_path: Some(added.worktree_path.to_string_lossy().into_owned()),
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
        parent_session_id,
    };

    if let Err(err) = registry.lock().await.add_session(session.clone()).await {
        // Roll back the new worktree if the Repository was removed mid-create.
        let _ = remove_worktree(repo_path, &added.worktree_path, &added.branch, true).await;
        return Err(map_registry_error(err));
    }
    Ok(session)
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
        // The renderer only reloads the list on this event, so without it the row keeps the old name.
        state.session_manager.notify_list_changed();
        Ok(Value::Null)
    })
}

/// `sessions.archive`: stops the live agent if any, then stamps `archivedAt`. A true second
/// argument does the same for every live descendant, deepest first.
pub fn sessions_archive(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match arg_str(&args, 0) {
            Some(id) => id.to_string(),
            None => {
                return Err(invalid_argument(
                    "sessions.archive expects (id: string, includeChildren?: boolean)",
                ))
            }
        };
        let include_children = match args.get(1) {
            None | Some(Value::Null) => false,
            Some(Value::Bool(flag)) => *flag,
            Some(_) => {
                return Err(invalid_argument(
                    "sessions.archive expects (id: string, includeChildren?: boolean)",
                ))
            }
        };
        if include_children {
            archive_core::archive_subtree_core(&state, &id).await?;
        } else {
            archive_core::archive_core(&state, &id).await?;
        }
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
        archive_core::restore_core(&state, &id).await?;
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
            let repository_id = project_binding(&session)?.repository_id;
            let repository = registry
                .get_repository(repository_id)
                .ok_or_else(|| not_found(format!("Project not found: {repository_id}")))?
                .clone();
            (session, repository)
        };
        let binding = project_binding(&session)?;
        // Held across the git calls, so a Retry cannot remove the worktree under them (#891).
        let _read_guard = crate::fs::worktree_access::read_guard_bounded(&id)
            .await
            .map_err(map_git_error)?;
        let check = delete_check_for_session(
            Path::new(&repository.path),
            Path::new(binding.worktree_path),
            binding.branch,
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
        let summary =
            compute_leftover_summary(&id, Path::new(project_binding(&session)?.worktree_path))
                .await;
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
        // Ahead of the confirmation check: "protected" is the more accurate refusal.
        if let Some(session) = state.registry.lock().await.get_session(&id) {
            refuse_if_personal(session)?;
        }
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
        delete_core::delete_core(&state, &id).await?;
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
            let repository_id = repo_binding(&session)?.repository_id;
            let repository = registry
                .get_repository(repository_id)
                .ok_or_else(|| not_found(format!("Project not found: {repository_id}")))?
                .clone();
            (session, repository)
        };
        let binding = repo_binding(&session)?;

        // Take the busy claim after `branch_exists`, so a branch-missing failure leaves the watcher running.
        let repo_path = Path::new(&repository.path);
        if !branch_exists(repo_path, binding.branch).await {
            return Err(IpcError::new(
                "branch-missing",
                format!("Branch not found: {}", binding.branch),
            ));
        }
        let worktree_guard = crate::fs::explorer_watch_state::begin_worktree_operation(
            state.app_handle.clone(),
            &id,
        );
        // Stop the git-changes panel's separate watcher too (#464).
        crate::fs::git_changes_watch_state::stop_watcher(&id);
        recreate_worktree(repo_path, Path::new(binding.worktree_path), binding.branch)
            .await
            .map_err(map_git_error)?;
        worktree_guard.finish(crate::fs::explorer_watch_state::WorktreeOperationOutcome::Reset);
        state.session_manager.notify_list_changed();
        Ok(Value::Null)
    })
}

mod diag;
use diag::{sessions_diff_stat, sessions_reveal_worktree};

// The archive and restore bodies, shared with the agent tools.
pub(crate) mod archive_core;
pub(crate) mod delete_core;

// Delete helpers (reclaim hook, Conversation cleanup, path check) live in `sessions_delete_support.rs`.
mod sessions_delete_support;
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

#[cfg(test)]
#[path = "sessions_lifecycle_gate_tests.rs"]
mod gate_tests;

#[cfg(test)]
#[path = "sessions_lifecycle_subtree_tests.rs"]
mod subtree_tests;

#[cfg(test)]
#[path = "sessions_lifecycle_checklist_tests.rs"]
mod checklist_tests;
