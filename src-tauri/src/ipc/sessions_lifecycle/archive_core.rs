// The archive and restore actions behind `sessions.archive` and `sessions.restore`, callable
// without IPC arguments so the agent tools share the exact same gates.

use crate::store::registry::SessionPatch;

use super::delete_in_flight;
use super::sessions_delete_support::on_worktree_released;
use crate::ipc::project_session::{project_binding, refuse_if_personal};
use crate::ipc::{map_registry_error, not_found, now_iso8601, AppState, IpcError};

/// Stops the live agent if any, then stamps `archivedAt`; children keep their parent link.
pub(crate) async fn archive_core(state: &AppState, id: &str) -> Result<(), IpcError> {
    delete_in_flight::refuse_if_deleting(id)?;
    match state.registry.lock().await.get_session(id) {
        Some(session) => refuse_if_personal(session)?,
        None => return Err(not_found(format!("Session not found: {id}"))),
    }
    // Mark busy before archiving so a concurrent watcher restart cannot race the operation.
    // The Explorer is reset on success and failure so it never shows a stale tree.
    let worktree_guard =
        crate::fs::explorer_watch_state::begin_worktree_operation(state.app_handle.clone(), id);
    // The git-changes watcher is separate from `begin_worktree_operation`; stop it too (#464).
    crate::fs::git_changes_watch_state::stop_watcher(id);
    state
        .session_manager
        .get_or_create_agent(id)
        .shutdown()
        .await;
    // Clears any stale pid record.
    crate::process::pid_records::remove_process_records_for_session(id).await;
    state
        .registry
        .lock()
        .await
        .update_session(
            id,
            SessionPatch {
                archived_at: Some(Some(now_iso8601())),
                ..Default::default()
            },
        )
        .await
        .map_err(map_registry_error)?;
    // Disk-reclaim hook for archived worktrees (#657, #658). Fires only on success.
    on_worktree_released(id);
    worktree_guard.finish(crate::fs::explorer_watch_state::WorktreeOperationOutcome::Reset);
    state.session_manager.notify_list_changed();
    Ok(())
}

/// Names what was already archived when a cascade stops part way, so nothing is left unreported.
fn partial_failure(error: IpcError, archived: &[String]) -> IpcError {
    if archived.is_empty() {
        return error;
    }
    IpcError::new(
        error.code,
        format!(
            "{}; already archived: {}",
            error.message,
            archived.join(", ")
        ),
    )
}

/// Archives `id` and every live descendant, deepest first, under the Project's tree gate so no
/// child can be created or moved into the set between reading it and archiving it.
pub(crate) async fn archive_subtree_core(state: &AppState, id: &str) -> Result<(), IpcError> {
    let repository_id = match state.registry.lock().await.get_session(id) {
        Some(session) => project_binding(session)?.repository_id.to_string(),
        None => return Err(not_found(format!("Session not found: {id}"))),
    };
    let _gate = crate::agent_tools::tree_gate::lock(&repository_id).await;
    let sessions = state.registry.lock().await.snapshot().sessions;
    let ids = crate::store::session_tree::archive_subtree_ids(&sessions, id);
    // Before the first archive, so a refusal never leaves the cascade half done.
    for member in &ids {
        delete_in_flight::refuse_if_deleting(member)?;
    }
    let mut archived = Vec::new();
    for member in &ids {
        archive_core(state, member)
            .await
            .map_err(|error| partial_failure(error, &archived))?;
        archived.push(member.clone());
    }
    Ok(())
}

/// Clears `archivedAt` unless the parent already has its maximum of live children.
pub(crate) async fn restore_core(state: &AppState, id: &str) -> Result<(), IpcError> {
    delete_in_flight::refuse_if_deleting(id)?;
    // Held to the patch: a racing agent create must not fill the parent's last slot between
    // this check and the restore (#1859).
    let repository_id = match state.registry.lock().await.get_session(id) {
        Some(session) => project_binding(session)?.repository_id.to_string(),
        None => return Err(not_found(format!("Session not found: {id}"))),
    };
    let _gate = crate::agent_tools::tree_gate::lock(&repository_id).await;
    {
        let registry = state.registry.lock().await;
        let Some(session) = registry.get_session(id) else {
            return Err(not_found(format!("Session not found: {id}")));
        };
        let sessions = registry.snapshot().sessions;
        if let Some(parent) = session.parent_session_id.as_deref() {
            let full = session.archived_at.is_some()
                && crate::store::session_tree::live_children(&sessions, parent).count()
                    >= crate::store::session_tree::MAX_LIVE_CHILDREN;
            if full {
                return Err(IpcError::new(
                    "child-limit",
                    format!(
                        "The parent Session already has {} live child Sessions",
                        crate::store::session_tree::MAX_LIVE_CHILDREN
                    ),
                ));
            }
        }
    }
    state
        .registry
        .lock()
        .await
        .update_session(
            id,
            SessionPatch {
                archived_at: Some(None),
                ..Default::default()
            },
        )
        .await
        .map_err(map_registry_error)?;
    // Reset the Explorer, which may still show the archived state.
    crate::fs::explorer_watch_state::notify_file_explorer_reset(&state.app_handle, id);
    state.session_manager.notify_list_changed();
    Ok(())
}
