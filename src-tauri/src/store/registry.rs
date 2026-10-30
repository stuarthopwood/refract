// Port of `src/main/store/registry.ts`: holds `registry.json`, every Repository and Session
// Refract knows about (data-model.md "registry.json", tasks.md T014). Enforces the two
// uniqueness rules from data-model.md: `worktreePath` is unique across all Sessions, and
// `branch` is unique within a Repository.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::atomic_json::{read_json_file, write_json_file};

/// Same shape as `src/shared/model.ts`'s `Repository`, minus `remote`: that field is computed on
/// demand (`git/remote.ts` in the Electron build; not ported here, `repositories.remotes` is a
/// `later`-milestone channel per `parity.md`) and, per that file's own doc comment, "NEVER read
/// from or written to `registry.json`" -- so the persisted shape never carries it at all.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub id: String,
    pub path: String,
    pub name: String,
    pub default_branch: String,
    pub added_at: String,
    /// Issue #887: the Project colour shown on its Session list header. Absent until chosen; an
    /// old registry without the field loads unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<ProjectColor>,
}

/// Issue #887: a Project colour, either one of the ten named presets (resolved to a per-theme
/// token in the renderer) or a custom hex stored exactly as the user typed it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProjectColor {
    Preset { id: String },
    Custom { hex: String },
}

/// Same shape as `src/shared/model.ts`'s `Session`. `stopped_on_request_conversation`/
/// `stopped_on_request_at_size` are simplified from the TS `string | null | undefined` (three
/// states: absent, null, or a real value) down to a plain `Option<String>`/`Option<i64>` (two
/// states: absent/null collapsed together, or a real value) -- both fields are written only by
/// `SessionAgent.onExit`'s requested-stop branch (Phase 3, not yet ported), so no milestone-1
/// handler in this slice ever sets or reads the "explicitly null" state the extra level would
/// preserve.
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
    /// #748: hide-from-list view flag, independent of `archived_at`. Absent in a pre-#748
    /// registry reads as `None` (visible); omitted when unset so old readers see no change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_turn_subagents: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped_on_request_conversation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped_on_request_at_size: Option<i64>,
    /// Lane RM (#741 decision 1): persisted mirror of `session::model::State.pinned` -- the
    /// in-memory flag alone reset to `false` on every restart, so a hand-picked model
    /// (`set_model`/`cycle_model`/a direct `/switch <model>` token) read back as the `default`
    /// role (and a later Settings role change could move it) the moment the app relaunched.
    /// `#[serde(default)]` only (no `skip_serializing_if`): an old `registry.json` written
    /// before this field existed deserialises it as `false` ("not pinned"), and every write
    /// from here on always includes it explicitly.
    #[serde(default)]
    pub pinned_model: bool,
    /// Pause mode (#477, spec 056): `Some` while the Session is paused, holding the queued message
    /// texts (text only) that send again on Resume. Persisted so a pause survives restarts and
    /// never auto-resumes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused_held: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastModel {
    pub provider: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// A partial update to one `Session` (port of `registry.ts`'s own `updateSession(id, patch:
/// Partial<Session>)`, used by `session::agent`'s `syncFromState`/`startNewConversation`/the
/// stopped-Session Conversation switch, Phase 3). `current_conversation`/`last_message_count`/
/// `archived_at` are tri-state (`None` = leave unchanged, `Some(None)` = clear to `null`,
/// `Some(Some(v))` = set) since their callers need to explicitly clear them (a brand new
/// Conversation, or `sessions.restore` un-archiving a Session, lane R2 #785); every other field
/// here is only ever set, never cleared, by its callers, so a plain `Option<T>` (`None` = leave
/// unchanged) is enough.
#[derive(Debug, Clone, Default)]
pub struct SessionPatch {
    pub last_activity_at: Option<String>,
    pub session_dir: Option<String>,
    pub current_conversation: Option<Option<String>>,
    pub last_message_count: Option<Option<i64>>,
    pub last_model: Option<LastModel>,
    pub last_thinking_level: Option<Option<String>>,
    // Lane R3 (issue #786): tri-state like `current_conversation` above -- both
    // `clear_stopped_on_request_marker` (every `launch()` attempt) and
    // `record_stopped_on_request_marker` (a requested-stop `onExit`) need to explicitly set
    // these back to `null`, not merely leave them unchanged.
    pub stopped_on_request_conversation: Option<Option<String>>,
    pub stopped_on_request_at_size: Option<Option<i64>>,
    pub archived_at: Option<Option<String>>,
    /// #748: tri-state like `archived_at` (`Some(None)` = unhide).
    pub hidden_at: Option<Option<String>>,
    /// Lane RM (#741 decision 1): set on every `set_model`/`cycle_model`/`handle_switch_text`
    /// pin and every `apply_role_now` un-pin -- a plain `Option<bool>` (no tri-state) since a
    /// bool has no "unset" state to preserve across patches.
    pub pinned_model: Option<bool>,
    /// Pause mode (#477): tri-state (`Some(None)` = resume).
    pub paused_held: Option<Option<Vec<String>>>,
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

/// Any error a `RegistryStore` method can produce: either a business-rule `RegistryError`
/// (duplicate/not-found/has-sessions) or an unexpected I/O failure writing `registry.json`.
/// Mirrors `registry.ts`'s own methods, which throw either a `RegistryError` or let a plain
/// `writeJsonFile` rejection propagate -- `ipc/util.ts`'s `mapStoreThrown` catches both the same
/// way at the IPC boundary (`Io` maps to the same `git-failed` fallback code the TS catch-all
/// uses for any error it does not recognise as a typed `GitError`/`RegistryError`).
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

    /// Issue #480: display-name-only edit. No uniqueness check on `name`. Rolls back on a failed
    /// write, the same discipline `remove_repository` below already uses: memory must not keep a
    /// name the disk copy never got.
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

    /// Issue #887: sets or clears (`None`) a Repository's Project colour, rolling back the
    /// in-memory value when the write fails, the same as `update_repository_name`.
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
            // Put the repository back if nothing else removed it meanwhile (a concurrent write
            // this call did not expect), then make one best-effort attempt to save the restored
            // data -- a write queued earlier may already have saved the removal.
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
        // Security remediation (Medium, ported from registry.ts): closes the race where a
        // Repository is removed while this Session's worktree/branch creation was still in
        // flight.
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

    /// `registry.ts`'s own `updateSession(id, patch)`: applies every `Some` field of `patch`,
    /// leaves every `None` field untouched, persists, and rolls back to the pre-patch Session on
    /// a failed write (same discipline every other mutator here already uses). Used by
    /// `session::agent` (Phase 3) after `get_state` (`syncFromState`), `new_session`
    /// (`startNewConversation`), and the stopped-Session Conversation switch.
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
        }
        if let Err(err) = self.persist().await {
            self.data.sessions[index] = previous;
            let _ = self.persist().await;
            return Err(err.into());
        }
        Ok(self.data.sessions[index].clone())
    }

    /// Removes the Session with `id` from the registry (`registry.ts`'s own `removeSession`,
    /// lane R2 #785's `sessions.delete`). Follows the exact same rollback-on-failed-write
    /// discipline as `remove_repository` above, adapted to Sessions and returning the removed
    /// `Session` by value (the caller still needs it -- `session_dir` -- after this call).
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
        if let Err(err) = self.persist().await {
            // Put the Session back if nothing else removed it meanwhile (a concurrent write
            // this call did not expect), then make one best-effort attempt to save the restored
            // data -- a write queued earlier may already have saved the removal.
            if !self.data.sessions.iter().any(|s| s.id == removed.id) {
                let insert_at = index.min(self.data.sessions.len());
                self.data.sessions.insert(insert_at, removed.clone());
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

/// Case- and drive-letter-insensitive path comparison for Windows (T011 rule): a lexical
/// resolve-and-normalise (never touches the filesystem, so it works for a worktree path that may
/// not exist yet) followed by a lowercase compare.
pub(crate) fn same_path(a: &str, b: &str) -> bool {
    resolve_path_lexical(a).to_lowercase() == resolve_path_lexical(b).to_lowercase()
}

/// The Rust equivalent of Node's `path.resolve(p)`: joins a relative path onto the current
/// working directory, then lexically collapses `.`/`..` components without requiring the path to
/// exist on disk (unlike `Path::canonicalize`, which would fail for a worktree not yet created).
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
