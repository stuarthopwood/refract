// `registry.json` store; `worktreePath` is unique across Sessions, `branch` within a Repository.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::atomic_json::{read_json_file, write_json_file};

/// A persisted Repository; `remote` is computed on demand and never stored in `registry.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub id: String,
    pub path: String,
    pub name: String,
    pub default_branch: String,
    pub added_at: String,
    /// Project colour for its Session list header (#887); absent until chosen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<ProjectColor>,
}

/// A Project colour: a named preset or a custom hex stored as typed (#887).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProjectColor {
    Preset { id: String },
    Custom { hex: String },
}

/// A persisted Session. The stopped-on-request fields collapse absent/null into `None`: nothing
/// reads the "explicitly null" state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub repository_id: String,
    pub name: String,
    pub branch: String,
    pub base_branch: String,
    pub worktree_path: String,
    pub session_dir: Option<String>,
    pub current_conversation: Option<String>,
    pub last_message_count: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_model: Option<LastModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_thinking_level: Option<String>,
    pub created_at: String,
    pub last_activity_at: String,
    pub archived_at: Option<String>,
    /// Hide-from-list flag, independent of `archived_at` (#748).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_turn_subagents: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped_on_request_conversation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped_on_request_at_size: Option<i64>,
    /// Persisted `State.pinned`, so a hand-picked model survives a restart (#741).
    /// Old registries without the field read as `false`.
    #[serde(default)]
    pub pinned_model: bool,
    /// `Some` while paused: queued message texts to resend on Resume; never auto-resumes (#477).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused_held: Option<Vec<String>>,
    /// The issue this Session was started from; absent for every other Session (#1310).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_issue: Option<OriginIssue>,
    /// The parent Session when this is a Child Session; absent for a root Session (#1859).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginIssue {
    pub number: u64,
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastModel {
    pub provider: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// A partial update to one `Session`. Tri-state fields: `None` = unchanged, `Some(None)` = clear,
/// `Some(Some(v))` = set; other fields are only ever set, so `None` = unchanged.
#[derive(Debug, Clone, Default)]
pub struct SessionPatch {
    pub last_activity_at: Option<String>,
    pub session_dir: Option<String>,
    pub current_conversation: Option<Option<String>>,
    pub last_message_count: Option<Option<i64>>,
    pub last_model: Option<LastModel>,
    pub last_thinking_level: Option<Option<String>>,
    // Tri-state: launch must be able to reset these to `null` (#786).
    pub stopped_on_request_conversation: Option<Option<String>>,
    pub stopped_on_request_at_size: Option<Option<i64>>,
    pub archived_at: Option<Option<String>>,
    /// Tri-state (`Some(None)` = unhide) (#748).
    pub hidden_at: Option<Option<String>>,
    /// Set on every model pin and role un-pin (#741).
    pub pinned_model: Option<bool>,
    /// Tri-state (`Some(None)` = resume) (#477).
    pub paused_held: Option<Option<Vec<String>>>,
    /// Tri-state (`Some(None)` = un-nest) (#1859).
    pub parent_session_id: Option<Option<String>>,
}

/// The full contents of `registry.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Registry {
    pub version: u8,
    #[serde(default)]
    pub repositories: Vec<Repository>,
    #[serde(default)]
    pub sessions: Vec<Session>,
}

fn default_registry() -> Registry {
    Registry {
        version: 1,
        repositories: Vec::new(),
        sessions: Vec::new(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistryErrorCode {
    Duplicate,
    NotFound,
    HasSessions,
}

impl RegistryErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Duplicate => "duplicate",
            Self::NotFound => "not-found",
            Self::HasSessions => "has-sessions",
        }
    }
}

#[derive(Debug)]
pub struct RegistryError {
    pub code: RegistryErrorCode,
    pub message: String,
}

impl RegistryError {
    pub fn new(code: RegistryErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for RegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for RegistryError {}

/// Single source of truth for the `has-sessions` refusal text.
pub const REPOSITORY_HAS_SESSIONS_MESSAGE: &str =
    "Delete this project's Sessions before removing it.";

/// Any error a `RegistryStore` method can produce: a business-rule `RegistryError` or an I/O
/// failure writing `registry.json`.
#[derive(Debug)]
pub enum RegistryStoreError {
    Registry(RegistryError),
    Io(std::io::Error),
}

impl From<RegistryError> for RegistryStoreError {
    fn from(err: RegistryError) -> Self {
        Self::Registry(err)
    }
}

impl From<std::io::Error> for RegistryStoreError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err)
    }
}

pub struct RegistryStore {
    file: PathBuf,
    data: Registry,
}

impl RegistryStore {
    pub async fn open(dir: &Path) -> std::io::Result<Self> {
        let file = dir.join("registry.json");
        let data = read_json_file(&file, default_registry).await?;
        Ok(Self { file, data })
    }

    pub fn snapshot(&self) -> Registry {
        Registry {
            version: 1,
            repositories: self.data.repositories.clone(),
            sessions: self.data.sessions.clone(),
        }
    }

    async fn persist(&self) -> std::io::Result<()> {
        write_json_file(&self.file, &self.data).await
    }

    pub async fn add_repository(&mut self, r: Repository) -> Result<(), RegistryStoreError> {
        if self
            .data
            .repositories
            .iter()
            .any(|existing| same_path(&existing.path, &r.path))
        {
            return Err(RegistryError::new(
                RegistryErrorCode::Duplicate,
                format!("Project already added: {}", r.path),
            )
            .into());
        }
        self.data.repositories.push(r);
        self.persist().await?;
        Ok(())
    }

    /// Display-name-only edit (#480); rolls back on a failed write so memory matches disk.
    pub async fn update_repository_name(
        &mut self,
        id: &str,
        name: String,
    ) -> Result<Repository, RegistryStoreError> {
        let index = self
            .data
            .repositories
            .iter()
            .position(|r| r.id == id)
            .ok_or_else(|| {
                RegistryError::new(
                    RegistryErrorCode::NotFound,
                    format!("Project not found: {id}"),
                )
            })?;
        let previous_name = self.data.repositories[index].name.clone();
        self.data.repositories[index].name = name;
        if let Err(err) = self.persist().await {
            self.data.repositories[index].name = previous_name;
            let _ = self.persist().await;
            return Err(err.into());
        }
        Ok(self.data.repositories[index].clone())
    }

    /// Sets or clears a Repository's Project colour; rolls back on a failed write (#887).
    pub async fn update_repository_color(
        &mut self,
        id: &str,
        color: Option<ProjectColor>,
    ) -> Result<Repository, RegistryStoreError> {
        let index = self
            .data
            .repositories
            .iter()
            .position(|r| r.id == id)
            .ok_or_else(|| {
                RegistryError::new(
                    RegistryErrorCode::NotFound,
                    format!("Project not found: {id}"),
                )
            })?;
        let previous = std::mem::replace(&mut self.data.repositories[index].color, color);
        if let Err(err) = self.persist().await {
            self.data.repositories[index].color = previous;
            let _ = self.persist().await;
            return Err(err.into());
        }
        Ok(self.data.repositories[index].clone())
    }

    pub async fn remove_repository(&mut self, id: &str) -> Result<(), RegistryStoreError> {
        let index = self
            .data
            .repositories
            .iter()
            .position(|r| r.id == id)
            .ok_or_else(|| {
                RegistryError::new(
                    RegistryErrorCode::NotFound,
                    format!("Project not found: {id}"),
                )
            })?;
        if self.data.sessions.iter().any(|s| s.repository_id == id) {
            return Err(RegistryError::new(
                RegistryErrorCode::HasSessions,
                REPOSITORY_HAS_SESSIONS_MESSAGE,
            )
            .into());
        }
        let removed = self.data.repositories.remove(index);
        if let Err(err) = self.persist().await {
            // Restore unless a concurrent call removed it; best-effort save, as an earlier
            // queued write may already have persisted the removal.
            if !self.data.repositories.iter().any(|r| r.id == removed.id) {
                let insert_at = index.min(self.data.repositories.len());
                self.data.repositories.insert(insert_at, removed);
            }
            let _ = self.persist().await;
            return Err(err.into());
        }
        Ok(())
    }

    pub async fn add_session(&mut self, s: Session) -> Result<(), RegistryStoreError> {
        if self
            .data
            .sessions
            .iter()
            .any(|existing| same_path(&existing.worktree_path, &s.worktree_path))
        {
            return Err(RegistryError::new(
                RegistryErrorCode::Duplicate,
                format!("Worktree already registered: {}", s.worktree_path),
            )
            .into());
        }
        if self.data.sessions.iter().any(|existing| {
            existing.repository_id == s.repository_id && existing.branch == s.branch
        }) {
            return Err(RegistryError::new(
                RegistryErrorCode::Duplicate,
                format!("Branch already used in this project: {}", s.branch),
            )
            .into());
        }
        // Closes the race where the Repository is removed while worktree creation is in flight.
        if !self
            .data
            .repositories
            .iter()
            .any(|r| r.id == s.repository_id)
        {
            return Err(RegistryError::new(
                RegistryErrorCode::NotFound,
                format!("Project not found: {}", s.repository_id),
            )
            .into());
        }
        let id = s.id.clone();
        self.data.sessions.push(s);
        if let Err(err) = self.persist().await {
            // The caller rolls back the worktree it just made on any failure here, so the
            // Session record must not outlive it.
            self.data.sessions.retain(|existing| existing.id != id);
            let _ = self.persist().await;
            return Err(err.into());
        }
        Ok(())
    }

    pub async fn update_session_name(
        &mut self,
        id: &str,
        name: String,
    ) -> Result<Session, RegistryStoreError> {
        let index = self
            .data
            .sessions
            .iter()
            .position(|s| s.id == id)
            .ok_or_else(|| {
                RegistryError::new(
                    RegistryErrorCode::NotFound,
                    format!("Session not found: {id}"),
                )
            })?;
        let previous_name = self.data.sessions[index].name.clone();
        self.data.sessions[index].name = name;
        if let Err(err) = self.persist().await {
            self.data.sessions[index].name = previous_name;
            let _ = self.persist().await;
            return Err(err.into());
        }
        Ok(self.data.sessions[index].clone())
    }

    /// Applies every `Some` field of `patch`, persists, and rolls back on a failed write.
    pub async fn update_session(
        &mut self,
        id: &str,
        patch: SessionPatch,
    ) -> Result<Session, RegistryStoreError> {
        let index = self
            .data
            .sessions
            .iter()
            .position(|s| s.id == id)
            .ok_or_else(|| {
                RegistryError::new(
                    RegistryErrorCode::NotFound,
                    format!("Session not found: {id}"),
                )
            })?;
        let previous = self.data.sessions[index].clone();
        {
            let session = &mut self.data.sessions[index];
            if let Some(value) = patch.last_activity_at {
                session.last_activity_at = value;
            }
            if let Some(value) = patch.session_dir {
                session.session_dir = Some(value);
            }
            if let Some(value) = patch.current_conversation {
                session.current_conversation = value;
            }
            if let Some(value) = patch.last_message_count {
                session.last_message_count = value;
            }
            if let Some(value) = patch.last_model {
                session.last_model = Some(value);
            }
            if let Some(value) = patch.last_thinking_level {
                session.last_thinking_level = value;
            }
            if let Some(value) = patch.stopped_on_request_conversation {
                session.stopped_on_request_conversation = value;
            }
            if let Some(value) = patch.stopped_on_request_at_size {
                session.stopped_on_request_at_size = value;
            }
            if let Some(value) = patch.archived_at {
                session.archived_at = value;
            }
            if let Some(value) = patch.hidden_at {
                session.hidden_at = value;
            }
            if let Some(value) = patch.pinned_model {
                session.pinned_model = value;
            }
            if let Some(value) = patch.paused_held {
                session.paused_held = value;
            }
            if let Some(value) = patch.parent_session_id {
                session.parent_session_id = value;
            }
        }
        if let Err(err) = self.persist().await {
            self.data.sessions[index] = previous;
            let _ = self.persist().await;
            return Err(err.into());
        }
        Ok(self.data.sessions[index].clone())
    }

    /// Removes the Session and returns it (callers still need `session_dir`); rolls back on a
    /// failed write. Live children are re-rooted in the same persist so no write ever leaves a
    /// link to a Session that is gone (#1859); archived children keep their link.
    pub async fn remove_session(&mut self, id: &str) -> Result<Session, RegistryStoreError> {
        let index = self
            .data
            .sessions
            .iter()
            .position(|s| s.id == id)
            .ok_or_else(|| {
                RegistryError::new(
                    RegistryErrorCode::NotFound,
                    format!("Session not found: {id}"),
                )
            })?;
        let removed = self.data.sessions.remove(index);
        let mut rerooted = Vec::new();
        for child in &mut self.data.sessions {
            if child.archived_at.is_none() && child.parent_session_id.as_deref() == Some(id) {
                child.parent_session_id = None;
                rerooted.push(child.id.clone());
            }
        }
        if let Err(err) = self.persist().await {
            // Restore unless a concurrent call removed it; best-effort save, as an earlier
            // queued write may already have persisted the removal.
            if !self.data.sessions.iter().any(|s| s.id == removed.id) {
                let insert_at = index.min(self.data.sessions.len());
                self.data.sessions.insert(insert_at, removed.clone());
                // Links go back with the Session, unless the child was re-parented meanwhile.
                for child in &mut self.data.sessions {
                    if child.parent_session_id.is_none() && rerooted.contains(&child.id) {
                        child.parent_session_id = Some(id.to_string());
                    }
                }
            }
            let _ = self.persist().await;
            return Err(err.into());
        }
        Ok(removed)
    }

    pub fn get_session(&self, id: &str) -> Option<&Session> {
        self.data.sessions.iter().find(|s| s.id == id)
    }

    pub fn get_repository(&self, id: &str) -> Option<&Repository> {
        self.data.repositories.iter().find(|r| r.id == id)
    }
}

/// Case-insensitive lexical path comparison; never touches the filesystem, so unborn worktrees work.
pub(crate) fn same_path(a: &str, b: &str) -> bool {
    resolve_path_lexical(a).to_lowercase() == resolve_path_lexical(b).to_lowercase()
}

/// Joins onto the cwd and lexically collapses `.`/`..`; unlike `canonicalize`, the path need not exist.
pub(crate) fn resolve_path_lexical(p: &str) -> String {
    use std::path::Component;

    let path = Path::new(p);
    let absolute: PathBuf = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };

    let mut collapsed = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::ParentDir => {
                collapsed.pop();
            }
            Component::CurDir => {}
            other => collapsed.push(other.as_os_str()),
        }
    }
    collapsed.to_string_lossy().into_owned()
}

#[cfg(test)]
#[path = "registry_tests.rs"]
mod tests;
