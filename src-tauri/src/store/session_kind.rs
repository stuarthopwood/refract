// Project vs Personal Session kinds and the registry invariants that depend on them.

use serde::{Deserialize, Serialize};

use super::registry::{
    same_path, Registry, RegistryError, RegistryErrorCode, Session, SessionPatch,
};

/// A row without `kind` on disk is a `project` Session, so old registries load unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    #[default]
    Project,
    Personal,
}

/// The four values a `project` Session always carries and a `personal` one never does.
#[derive(Debug, Clone, Copy)]
pub struct ProjectBinding<'a> {
    pub repository_id: &'a str,
    pub branch: &'a str,
    pub base_branch: &'a str,
    pub worktree_path: &'a str,
}

impl Session {
    pub fn is_personal(&self) -> bool {
        self.kind == SessionKind::Personal
    }

    /// `None` for a `personal` Session (and for a malformed `project` row, which `add_session`
    /// and `open` refuse).
    pub fn project_binding(&self) -> Option<ProjectBinding<'_>> {
        Some(ProjectBinding {
            repository_id: self.repository_id.as_deref()?,
            branch: self.branch.as_deref()?,
            base_branch: self.base_branch.as_deref()?,
            worktree_path: self.worktree_path.as_deref()?,
        })
    }

    fn has_no_project_fields(&self) -> bool {
        self.repository_id.is_none()
            && self.branch.is_none()
            && self.base_branch.is_none()
            && self.worktree_path.is_none()
    }

    /// A stored row is valid when `project` carries all four fields and `personal` none.
    pub(super) fn is_well_formed(&self) -> bool {
        match self.kind {
            SessionKind::Project => self.project_binding().is_some(),
            SessionKind::Personal => self.has_no_project_fields(),
        }
    }
}

/// Single source of truth for the `personal-agent-protected` refusal text.
pub const PERSONAL_AGENT_PROTECTED_MESSAGE: &str =
    "The Personal Agent cannot be archived or deleted.";

/// The Personal Agent's working folder: the developer's home folder, resolved on every call and
/// never stored. A folder that cannot be resolved or no longer exists fails with a message the
/// caller shows; there is no fallback directory. Shared by the launch, the
/// attachment handlers and the advisor roster, so there is one home lookup.
pub async fn personal_home_folder() -> Result<std::path::PathBuf, String> {
    let Some(home) = dirs::home_dir() else {
        return Err("The home folder could not be resolved.".to_string());
    };
    match tokio::fs::metadata(&home).await {
        Ok(meta) if meta.is_dir() => Ok(home),
        _ => Err(format!(
            "The home folder {} no longer exists.",
            home.display()
        )),
    }
}

pub(super) fn personal_agent_protected() -> RegistryError {
    RegistryError::new(
        RegistryErrorCode::PersonalAgentProtected,
        PERSONAL_AGENT_PROTECTED_MESSAGE,
    )
}

fn invalid_shape(message: &str) -> RegistryError {
    RegistryError::new(RegistryErrorCode::InvalidShape, message)
}

fn is_personal_id(data: &Registry, id: &str) -> bool {
    data.sessions.iter().any(|s| s.id == id && s.is_personal())
}

/// Refusals for a patch to an existing row: the Personal Agent is never archived, hidden or
/// nested, and nothing becomes its child. Clearing a link stays allowed.
pub(super) fn check_session_patch(
    data: &Registry,
    index: usize,
    patch: &SessionPatch,
) -> Result<(), RegistryError> {
    if data.sessions[index].is_personal()
        && (matches!(patch.archived_at, Some(Some(_)))
            || matches!(patch.hidden_at, Some(Some(_)))
            || matches!(patch.parent_session_id, Some(Some(_))))
    {
        return Err(RegistryError::new(
            RegistryErrorCode::PersonalAgentProtected,
            "The Personal Agent cannot be archived, hidden or nested under another Session.",
        ));
    }
    if let Some(Some(parent)) = &patch.parent_session_id {
        if is_personal_id(data, parent) {
            return Err(invalid_shape(PERSONAL_NO_CHILDREN_MESSAGE));
        }
    }
    Ok(())
}

const PERSONAL_NO_CHILDREN_MESSAGE: &str = "A Personal Agent cannot have child Sessions.";

/// Every check `add_session` makes before a row is stored.
pub(super) fn check_new_session(data: &Registry, s: &Session) -> Result<(), RegistryError> {
    if s.parent_session_id
        .as_deref()
        .is_some_and(|parent| is_personal_id(data, parent))
    {
        return Err(invalid_shape(PERSONAL_NO_CHILDREN_MESSAGE));
    }
    if s.kind == SessionKind::Personal {
        if !s.has_no_project_fields() {
            return Err(invalid_shape(
                "A Personal Agent has no Project, branch or worktree.",
            ));
        }
        if s.parent_session_id.is_some() || s.hidden_at.is_some() || s.archived_at.is_some() {
            return Err(invalid_shape(
                "A Personal Agent is never hidden, archived or nested.",
            ));
        }
        if data.sessions.iter().any(Session::is_personal) {
            return Err(RegistryError::new(
                RegistryErrorCode::PersonalAgentExists,
                "A Personal Agent already exists.",
            ));
        }
        return Ok(());
    }
    let Some(binding) = s.project_binding() else {
        return Err(RegistryError::new(
            RegistryErrorCode::InvalidShape,
            "A Project Session needs a Project, branch and worktree.",
        ));
    };
    if data.sessions.iter().any(|existing| {
        existing
            .worktree_path
            .as_deref()
            .is_some_and(|p| same_path(p, binding.worktree_path))
    }) {
        return Err(RegistryError::new(
            RegistryErrorCode::Duplicate,
            format!("Worktree already registered: {}", binding.worktree_path),
        ));
    }
    if data.sessions.iter().any(|existing| {
        existing.repository_id.as_deref() == Some(binding.repository_id)
            && existing.branch.as_deref() == Some(binding.branch)
    }) {
        return Err(RegistryError::new(
            RegistryErrorCode::Duplicate,
            format!("Branch already used in this project: {}", binding.branch),
        ));
    }
    // Closes the race where the Repository is removed while worktree creation is in flight.
    if !data
        .repositories
        .iter()
        .any(|r| r.id == binding.repository_id)
    {
        return Err(RegistryError::new(
            RegistryErrorCode::NotFound,
            format!("Project not found: {}", binding.repository_id),
        ));
    }
    Ok(())
}

/// Keeps the earliest `personal` row by `created_at` as the singleton and warns about the rest;
/// nothing is deleted.
pub(super) fn warn_duplicate_personal(data: &Registry) {
    let mut personal: Vec<&Session> = data.sessions.iter().filter(|s| s.is_personal()).collect();
    if personal.len() < 2 {
        return;
    }
    personal.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    let others: Vec<&str> = personal[1..].iter().map(|s| s.id.as_str()).collect();
    log::warn!(
        "registry has more than one Personal Agent row; keeping {} (also present: {others:?})",
        personal[0].id
    );
}
