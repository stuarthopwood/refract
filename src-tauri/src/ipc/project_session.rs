// Narrowing helpers: Project-scoped handlers treat the Personal Agent as absent or protected.

use super::{not_found, IpcError};
use crate::store::registry::Session;
use crate::store::session_kind::ProjectBinding;

/// The Project fields of `session`; a Personal Agent reads as "not found" to Project features.
pub fn project_binding(session: &Session) -> Result<ProjectBinding<'_>, IpcError> {
    session
        .project_binding()
        .ok_or_else(|| not_found(format!("Session not found: {}", session.id)))
}

/// Refuses archive/delete of the Personal Agent before anything changes.
pub fn refuse_if_personal(session: &Session) -> Result<(), IpcError> {
    if session.is_personal() {
        return Err(IpcError::new(
            "personal-agent-protected",
            "The Personal Agent cannot be archived or deleted.",
        ));
    }
    Ok(())
}
