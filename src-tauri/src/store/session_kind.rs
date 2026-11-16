// Project vs Personal Session kinds and the registry invariants that depend on them.

use serde::{Deserialize, Serialize};

use super::registry::{same_path, Registry, RegistryError, RegistryErrorCode, Session};

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

pub(super) fn personal_agent_protected() -> RegistryError {
    RegistryError::new(
        RegistryErrorCode::PersonalAgentProtected,
        PERSONAL_AGENT_PROTECTED_MESSAGE,
    )
}

/// Every check `add_session` makes before a row is stored.
pub(super) fn check_new_session(data: &Registry, s: &Session) -> Result<(), RegistryError> {
    if s.kind == SessionKind::Personal {
        if !s.has_no_project_fields() {
            return Err(RegistryError::new(
                RegistryErrorCode::InvalidShape,
                "A Personal Agent has no Project, branch or worktree.",
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
