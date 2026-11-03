// Background half of `sessions.delete`: the handler runs the refusal checks, then hands the removal here.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{LazyLock, Mutex, MutexGuard};

use tokio::sync::OwnedRwLockWriteGuard;

use crate::fs::explorer_watch_state::{WorktreeOperationGuard, WorktreeOperationOutcome};
use crate::git::worktree_delete::remove_session_worktree;
use crate::ipc::{map_git_error, map_registry_error, AppState, IpcError};
use crate::store::registry::{Repository, Session};

use super::sessions_delete_support::{
    delete_session_conversations, is_strict_descendant_of_omp_sessions, on_worktree_released,
};

static IN_FLIGHT: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// A poisoned lock only means another thread panicked mid-insert; the set itself is still valid.
fn in_flight() -> MutexGuard<'static, HashSet<String>> {
    IN_FLIGHT.lock().unwrap_or_else(|err| err.into_inner())
}

/// True while `id` has a background removal running.
pub fn is_deleting(id: &str) -> bool {
    in_flight().contains(id)
}

/// Every Session id with a removal running, sorted so the answer is stable.
pub fn deleting_ids() -> Vec<String> {
    let mut ids: Vec<String> = in_flight().iter().cloned().collect();
    ids.sort();
    ids
}

/// True while any removal runs; the quit guard asks before the app exits.
pub fn any_in_flight() -> bool {
    !in_flight().is_empty()
}

/// Claims `id`; false when a removal for it is already running.
fn mark(id: &str) -> bool {
    in_flight().insert(id.to_string())
}

fn unmark(id: &str) {
    in_flight().remove(id);
}

fn already_deleting() -> IpcError {
    IpcError::new("worktree-busy", "This Session is already being deleted.")
}

/// The refusal every lifecycle handler gives for a Session whose removal is running.
pub fn refuse_if_deleting(id: &str) -> Result<(), IpcError> {
    if is_deleting(id) {
        return Err(already_deleting());
    }
    Ok(())
}

/// Starts the removal and returns at once. The spawned task owns both guards until it ends, so no
/// reader or lifecycle operation can touch the worktree meanwhile. Refuses if another removal for
/// this Session claimed it between the handler's first check and now.
pub fn start(
    state: AppState,
    session: Session,
    repository: Repository,
    write_guard: OwnedRwLockWriteGuard<()>,
    worktree_guard: WorktreeOperationGuard,
) -> Result<(), IpcError> {
    let id = session.id.clone();
    if !mark(&id) {
        return Err(already_deleting());
    }
    state.session_manager.notify_list_changed();

    tokio::spawn(async move {
        // The removal runs in its own task, so a panic surfaces as a JoinError here instead of
        // leaving the id marked and the renderer waiting for an event that never comes.
        let removal = tokio::spawn(remove(
            state.clone(),
            session,
            repository,
            write_guard,
            worktree_guard,
        ))
        .await;
        let outcome = removal.unwrap_or_else(|err| {
            log::error!("sessions.delete: removal task for {id} ended abnormally: {err}");
            Err(IpcError::new(
                "git-failed",
                "Deleting this Session stopped unexpectedly.",
            ))
        });
        unmark(&id);
        match outcome {
            Ok(()) => state.session_manager.emit_session_deleted(&id),
            Err(err) => {
                state
                    .session_manager
                    .emit_session_delete_failed(&id, err.code, &err.message)
            }
        }
        state.session_manager.notify_list_changed();
    });
    Ok(())
}

/// Removes the worktree, its Conversation files, then the registry entry. On failure the worktree
/// guard drops unfinished, which resets the Explorer as a failed foreground delete did.
async fn remove(
    state: AppState,
    session: Session,
    repository: Repository,
    _write_guard: OwnedRwLockWriteGuard<()>,
    worktree_guard: WorktreeOperationGuard,
) -> Result<(), IpcError> {
    let id = &session.id;
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
        .remove_session(id)
        .await
        .map_err(map_registry_error)?;
    state.session_manager.remove_agent(id);
    // Drop this Session's absolute-path allow-list entry, so the map does not grow.
    crate::ipc::file_attachments::forget_session(id);
    // Disk-reclaim hook, as for archive (#657, #658). Success only.
    on_worktree_released(id);
    worktree_guard.finish(WorktreeOperationOutcome::Forgotten);
    Ok(())
}
