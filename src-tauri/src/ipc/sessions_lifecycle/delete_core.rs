// The delete action behind `sessions.delete`, split so an agent tool can run the refusals before
// asking for approval and the destructive half only after.

use std::path::Path;

use crate::git::git::GitError;
use crate::git::worktree_holders;
use crate::process::pid_records;
use crate::session::SessionStatus;
use crate::store::registry::{Repository, Session};

use super::delete_in_flight;
use crate::ipc::project_session::{project_binding, refuse_if_personal};
use crate::ipc::{map_git_error, not_found, AppState, IpcError};

async fn session_and_repository(
    state: &AppState,
    id: &str,
) -> Result<(Session, Repository), IpcError> {
    let registry = state.registry.lock().await;
    let session = registry
        .get_session(id)
        .ok_or_else(|| not_found(format!("Session not found: {id}")))?
        .clone();
    refuse_if_personal(&session)?;
    let repository_id = project_binding(&session)?.repository_id;
    let repository = registry
        .get_repository(repository_id)
        .ok_or_else(|| not_found(format!("Project not found: {repository_id}")))?
        .clone();
    Ok((session, repository))
}

/// Runs the refusals that leave the Session untouched and claims nothing, so a tool can call it
/// before raising its approval card.
pub(crate) async fn delete_precheck(
    state: &AppState,
    id: &str,
) -> Result<(Session, Repository), IpcError> {
    delete_in_flight::refuse_if_deleting(id)?;
    let (session, repository) = session_and_repository(state, id).await?;
    let binding = project_binding(&session)?;
    // Cancel the leftover walk first so Refract's own handles are not read as external holders.
    crate::fs::worktree_access::cancel_walk_bounded(id)
        .await
        .map_err(map_git_error)?;
    let _write_guard = crate::fs::worktree_access::write_guard_bounded(id)
        .await
        .map_err(map_git_error)?;
    let own_pids = pid_records::pids_for_session(id).await;
    worktree_holders::check_named_holders(
        Path::new(&repository.path),
        Path::new(binding.worktree_path),
        &own_pids,
    )
    .await
    .map_err(map_git_error)?;
    Ok((session, repository))
}

/// Removes the worktree, its Conversation files and the registry entry in the background; the
/// outcome arrives as an event.
pub(crate) async fn delete_core(state: &AppState, id: &str) -> Result<(), IpcError> {
    delete_in_flight::refuse_if_deleting(id)?;
    let (session, repository) = session_and_repository(state, id).await?;
    let binding = project_binding(&session)?;

    // Cancel the leftover walk first so Refract's own handles are not read as external holders.
    crate::fs::worktree_access::cancel_walk_bounded(id)
        .await
        .map_err(map_git_error)?;

    // Held through removal so no new reader starts (#1055); the background task takes it over.
    let write_guard = crate::fs::worktree_access::write_guard_bounded(id)
        .await
        .map_err(map_git_error)?;

    // Check named file holders before stopping the agent, so a refusal changes nothing. Own pids are excluded.
    let own_pids = pid_records::pids_for_session(id).await;
    // Read the status directly; the own-pids list can be stale after a crash.
    let was_running =
        state.session_manager.get_or_create_agent(id).status().await != SessionStatus::Stopped;
    worktree_holders::check_named_holders(
        Path::new(&repository.path),
        Path::new(binding.worktree_path),
        &own_pids,
    )
    .await
    .map_err(map_git_error)?;

    // Claimed once the refusals that leave the Session untouched pass, so other handlers refuse
    // for the whole destructive phase; dropping the claim on any error path unmarks it.
    let claim = delete_in_flight::claim(id)?;
    // Resets the Explorer on failure too (see `archive_core`).
    let worktree_guard =
        crate::fs::explorer_watch_state::begin_worktree_operation(state.app_handle.clone(), id);
    // Stop the git-changes panel's separate watcher too (#464).
    crate::fs::git_changes_watch_state::stop_watcher(id);
    // Shut the agent down before removal: a live process holds the worktree's cwd.
    // The cwd-holder check must run after this, or it refuses every Delete of a running Session.
    state
        .session_manager
        .get_or_create_agent(id)
        .shutdown()
        .await;

    // A refused Delete restarts a Session that was running before the call (#891).
    if let Err(err) = worktree_holders::check_folder_in_use(
        Path::new(&repository.path),
        Path::new(binding.worktree_path),
        id,
        &own_pids,
    )
    .await
    {
        let code = err.code;
        let mut message = err.message;
        if was_running {
            let agent = state.session_manager.get_or_create_agent(id);
            let _ = agent.start_unchecked().await;
            if agent.status().await == SessionStatus::Stopped {
                message = format!(
                    "{message} Also, Refract could not restart this Session's agent automatically -- reopen it yourself."
                );
            }
        }
        return Err(map_git_error(GitError::new(code, message)));
    }

    crate::process::pid_records::remove_process_records_for_session(id).await;

    delete_in_flight::start(
        state.clone(),
        session,
        repository,
        write_guard,
        worktree_guard,
        claim,
    );
    Ok(())
}
