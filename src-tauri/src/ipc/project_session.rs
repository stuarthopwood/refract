// Narrowing helpers: Project-scoped handlers treat the Personal Agent as absent or protected.

use super::{not_found, AppState, IpcError};
use crate::store::registry::Session;
use crate::store::session_kind::{
    personal_home_folder, ProjectBinding, PERSONAL_AGENT_PROTECTED_MESSAGE,
};

/// The Project fields of `session`; a Personal Agent reads as "not found" to Project features.
pub fn project_binding(session: &Session) -> Result<ProjectBinding<'_>, IpcError> {
    session
        .project_binding()
        .ok_or_else(|| not_found(format!("Session not found: {}", session.id)))
}

/// The folder a Session's files live in: the worktree of a Project Session, or the home folder
/// (resolved on every call, never stored) for the Personal Agent. The registry lock is released
/// before the home folder is touched; an unresolvable home folder is a visible error.
pub async fn session_working_dir(state: &AppState, session_id: &str) -> Result<String, IpcError> {
    let project_worktree = {
        let registry = state.registry.lock().await;
        let session = registry
            .get_session(session_id)
            .ok_or_else(|| not_found(format!("Session not found: {session_id}")))?;
        session
            .project_binding()
            .map(|binding| binding.worktree_path.to_string())
    };
    if let Some(worktree_path) = project_worktree {
        return Ok(worktree_path);
    }
    personal_home_folder()
        .await
        .map(|home| home.to_string_lossy().into_owned())
        .map_err(|message| IpcError::new("working-folder-unavailable", message))
}

/// Message carried by the `no-repository` result of repo-only handlers.
pub const NO_REPOSITORY_MESSAGE: &str =
    "The Personal Agent isn't linked to a Project, so there is no repository to read.";

/// The Project fields of `session` for a repo-only feature (git changes, files, diff, Worktree
/// actions). A Personal Agent gets the typed, expected `no-repository` result, not `not-found`.
pub fn repo_binding(session: &Session) -> Result<ProjectBinding<'_>, IpcError> {
    session
        .project_binding()
        .ok_or_else(|| IpcError::new("no-repository", NO_REPOSITORY_MESSAGE))
}

/// Refuses archive/delete of the Personal Agent before anything changes.
pub fn refuse_if_personal(session: &Session) -> Result<(), IpcError> {
    if session.is_personal() {
        return Err(IpcError::new(
            "personal-agent-protected",
            PERSONAL_AGENT_PROTECTED_MESSAGE,
        ));
    }
    Ok(())
}
