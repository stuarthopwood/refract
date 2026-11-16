// Narrowing helpers: Project-scoped handlers treat the Personal Agent as absent or protected.

use super::{not_found, IpcError};
use crate::store::registry::Session;
use crate::store::session_kind::{ProjectBinding, PERSONAL_AGENT_PROTECTED_MESSAGE};

/// The Project fields of `session`; a Personal Agent reads as "not found" to Project features.
pub fn project_binding(session: &Session) -> Result<ProjectBinding<'_>, IpcError> {
    session
        .project_binding()
        .ok_or_else(|| not_found(format!("Session not found: {}", session.id)))
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
