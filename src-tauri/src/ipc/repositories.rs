// IPC handlers for `repositories.*`: list, add, remove, branches, pickFolder, userName, rename
// and remotes.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::{OnceCell, Semaphore};

use crate::git::git::{git_raw, repo_info};
use crate::git::remote::{repository_remote, RepositoryRemoteKind};
use crate::git::worktrees::{default_branch, list_branches};
use crate::store::registry::{Repository, Session, REPOSITORY_HAS_SESSIONS_MESSAGE};

use super::{
    arg_str, find_repository, invalid_argument, map_git_error, map_registry_error, now_iso8601,
    required_str, with_resolved_remote, AppState, Dispatcher, HandlerFuture, IpcError,
};

pub fn register(d: &mut Dispatcher) {
    d.register("repositories.list", repositories_list);
    d.register("repositories.add", repositories_add);
    d.register("repositories.remove", repositories_remove);
    d.register("repositories.rename", repositories_rename);
    d.register("repositories.branches", repositories_branches);
    d.register("repositories.remotes", repositories_remotes);
    d.register("repositories.pickFolder", repositories_pick_folder);
    d.register("repositories.userName", repositories_user_name);
}

/// `repositories.userName`: `git config user.name` in the checkout, else the Windows account
/// name; cached per repository id so the avatar/name never re-shells out.
static USER_NAME_CACHE: LazyLock<StdMutex<HashMap<String, String>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

async fn resolve_user_name(repository_id: &str, repo_path: &std::path::Path) -> String {
    if let Some(cached) = USER_NAME_CACHE
        .lock()
        .expect("USER_NAME_CACHE mutex poisoned")
        .get(repository_id)
    {
        return cached.clone();
    }
    let result = git_raw(repo_path, &["config", "user.name"], None).await;
    let configured = if result.code == 0 {
        result.stdout.trim().to_string()
    } else {
        String::new()
    };
    let name = if configured.is_empty() {
        whoami_username()
    } else {
        configured
    };
    USER_NAME_CACHE
        .lock()
        .expect("USER_NAME_CACHE mutex poisoned")
        .insert(repository_id.to_string(), name.clone());
    name
}

/// The logged-in Windows account name from `USERNAME` (no `whoami` dependency).
fn whoami_username() -> String {
    std::env::var("USERNAME").unwrap_or_else(|_| "unknown".to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
enum BranchEntryKind {
    #[serde(rename = "default")]
    Default,
    #[serde(rename = "branch")]
    Branch,
    #[serde(rename = "session")]
    Session {
        #[serde(rename = "sessionName", skip_serializing_if = "Option::is_none")]
        session_name: Option<String>,
        archived: bool,
    },
}

#[derive(Debug, Serialize)]
struct BranchEntry {
    name: String,
    #[serde(flatten)]
    kind: BranchEntryKind,
}

/// Base branch picker entries: the default branch, then plain branches, then Session-owned
/// branches labelled and sorted by the Session's display name.
fn branch_entries(
    branches: Vec<String>,
    default_name: &str,
    sessions: &[Session],
) -> Vec<BranchEntry> {
    let owners: HashMap<&str, &Session> = sessions.iter().map(|s| (s.branch.as_str(), s)).collect();
    let mut entries = Vec::new();
    if branches.iter().any(|b| b == default_name) {
        entries.push(BranchEntry {
            name: default_name.to_string(),
            kind: BranchEntryKind::Default,
        });
    }
    let mut session_entries: Vec<BranchEntry> = Vec::new();
    for name in &branches {
        if name == default_name {
            continue;
        }
        if let Some(owner) = owners.get(name.as_str()) {
            session_entries.push(BranchEntry {
                name: name.clone(),
                kind: BranchEntryKind::Session {
                    session_name: Some(owner.name.clone()),
                    archived: owner.archived_at.is_some(),
                },
            });
        } else {
            entries.push(BranchEntry {
                name: name.clone(),
                kind: BranchEntryKind::Branch,
            });
        }
    }
    session_entries.sort_by(|a, b| {
        let name_of = |entry: &BranchEntry| match &entry.kind {
            BranchEntryKind::Session { session_name, .. } => {
                session_name.clone().unwrap_or_default()
            }
            _ => String::new(),
        };
        name_of(a).to_lowercase().cmp(&name_of(b).to_lowercase())
    });
    entries.extend(session_entries);
    entries
}

/// Embeds `remote` into `repository`'s JSON (the wire `Repository` has a `remote` field).
pub(super) fn with_remote(repository: &Repository, remote: &RepositoryRemoteKind) -> Value {
    let mut value =
        serde_json::to_value(repository).expect("Repository is always JSON-serialisable");
    value
        .as_object_mut()
        .expect("Repository serialises to a JSON object")
        .insert(
            "remote".to_string(),
            serde_json::to_value(remote).expect("RepositoryRemoteKind is always JSON-serialisable"),
        );
    value
}

fn with_unknown_remote(repository: &Repository) -> Value {
    with_remote(repository, &RepositoryRemoteKind::Unknown)
}

pub fn repositories_list(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let repositories = state.registry.lock().await.snapshot().repositories;
        let with_placeholder: Vec<Value> = repositories.iter().map(with_unknown_remote).collect();
        Ok(Value::Array(with_placeholder))
    })
}

pub fn repositories_add(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let repo_path = match arg_str(&args, 0) {
            Some(path) => path.to_string(),
            None => return Err(invalid_argument("repositories.add expects a string path")),
        };
        add_repository_at(&state, &repo_path).await
    })
}

/// The `repositories.add` body, shared with Clone from GitHub so a clone registers like an add.
pub(super) async fn add_repository_at(
    state: &AppState,
    repo_path: &str,
) -> Result<Value, IpcError> {
    let info = repo_info(std::path::Path::new(repo_path))
        .await
        .map_err(map_git_error)?;
    let branch = default_branch(std::path::Path::new(&info.path))
        .await
        .map_err(map_git_error)?;
    let repository = Repository {
        id: uuid::Uuid::new_v4().to_string(),
        path: info.path.clone(),
        name: std::path::Path::new(&info.path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| info.path.clone()),
        default_branch: branch,
        added_at: now_iso8601(),
        color: None,
    };
    state
        .registry
        .lock()
        .await
        .add_repository(repository.clone())
        .await
        .map_err(map_registry_error)?;
    // Same eager recompute as `.rename`; `repository_remote` caps itself at 3s and `None` falls
    // back to `unknown`, so a slow `git remote` never stalls adding a project.
    Ok(with_resolved_remote(&repository).await)
}

pub fn repositories_remove(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = required_str(&args, 0, "repositories.remove expects a string id")?;
        let has_owned_sessions = state
            .registry
            .lock()
            .await
            .snapshot()
            .sessions
            .iter()
            .any(|s| s.repository_id == id);
        if has_owned_sessions {
            return Err(IpcError::new(
                "has-sessions",
                REPOSITORY_HAS_SESSIONS_MESSAGE,
            ));
        }
        state
            .registry
            .lock()
            .await
            .remove_repository(&id)
            .await
            .map_err(map_registry_error)?;
        Ok(Value::Null)
    })
}

/// Name rules (#480): trimmed, at most 60 characters, no control characters. An empty name is not
/// an error; the caller resets it to the folder basename (`resolve_repository_name`).
const MAX_REPOSITORY_NAME_LENGTH: usize = 60;

/// Hand-enumerated `\p{Cf}` ranges (no Unicode-category crate); `\p{Cc}` is `char::is_control`.
/// `\u2028`/`\u2029` fall outside both and are checked explicitly.
fn is_unicode_format_char(c: char) -> bool {
    matches!(c,
        '\u{00AD}'
        | '\u{0600}'..='\u{0605}'
        | '\u{061C}'
        | '\u{06DD}'
        | '\u{070F}'
        | '\u{0890}'..='\u{0891}'
        | '\u{08E2}'
        | '\u{180E}'
        | '\u{200B}'..='\u{200F}'
        | '\u{202A}'..='\u{202E}'
        | '\u{2060}'..='\u{2064}'
        | '\u{2066}'..='\u{206F}'
        | '\u{FEFF}'
        | '\u{FFF9}'..='\u{FFFB}'
        | '\u{110BD}'
        | '\u{110CD}'
        | '\u{13430}'..='\u{1343F}'
        | '\u{1BCA0}'..='\u{1BCA3}'
        | '\u{1D173}'..='\u{1D17A}'
        | '\u{E0001}'
        | '\u{E0020}'..='\u{E007F}'
    )
}

/// Error message for an invalid non-empty name, else `None`. ZWNJ/ZWJ are allowed: legitimate in
/// emoji sequences and Persian/Arabic/Indic scripts.
fn validate_repository_name(trimmed: &str) -> Option<String> {
    if trimmed.chars().count() > MAX_REPOSITORY_NAME_LENGTH {
        return Some(format!(
            "name too long (max {MAX_REPOSITORY_NAME_LENGTH} characters)"
        ));
    }
    let has_control_or_format = trimmed
        .chars()
        .filter(|&c| c != '\u{200C}' && c != '\u{200D}')
        .any(|c| c.is_control() || is_unicode_format_char(c) || c == '\u{2028}' || c == '\u{2029}');
    if has_control_or_format {
        return Some("name must not contain control characters".to_string());
    }
    None
}

/// Clearing the field resets the name to the folder basename; a name of only ZWNJ/ZWJ joiners
/// and whitespace counts as blank.
fn resolve_repository_name(trimmed: &str, basename: &str) -> String {
    let visible: String = trimmed
        .chars()
        .filter(|&c| c != '\u{200C}' && c != '\u{200D}')
        .collect();
    if visible.trim().is_empty() {
        basename.to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn repositories_rename(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = required_str(&args, 0, "repositories.rename expects (id, name) strings")?;
        let name = required_str(&args, 1, "repositories.rename expects (id, name) strings")?;
        // Rejected before `trim()` as defence in depth: IPC payloads have no size cap here; the
        // real guard is `validate_repository_name`'s length check.
        if name.chars().count() > 4 * MAX_REPOSITORY_NAME_LENGTH {
            return Err(invalid_argument("repositories.rename name too long"));
        }
        let repository = find_repository(&state, &id).await?;
        let trimmed = name.trim();
        // No channel prefix: the message shows inline in the rename field's alert, never a toast.
        if let Some(validation_error) = validate_repository_name(trimmed) {
            return Err(invalid_argument(validation_error));
        }
        let basename = std::path::Path::new(&repository.path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| repository.path.clone());
        let next_name = resolve_repository_name(trimmed, &basename);
        let updated = state
            .registry
            .lock()
            .await
            .update_repository_name(&id, next_name)
            .await
            .map_err(map_registry_error)?;
        state.session_manager.notify_list_changed();
        // Recompute the real remote inline like `.add` (#528); a 3s timeout (`None`) falls back
        // to `unknown`.
        Ok(with_resolved_remote(&updated).await)
    })
}

/// Cap on concurrent `git` child processes in one `repositories.remotes` sweep.
const REMOTE_CONCURRENCY: usize = 8;

/// Deadline for the WHOLE `repositories.remotes` sweep, on top of each call's own 3s cap.
const REMOTE_DEADLINE: Duration = Duration::from_secs(10);

/// Runs remote checks concurrently under one semaphore and deadline. A check cut off is omitted
/// (never an `unknown` overwriting a confirmed value) and aborted so `kill_on_drop` reaps it (#528).
async fn remotes_bounded(repositories: Vec<Repository>) -> Value {
    let semaphore = Arc::new(Semaphore::new(REMOTE_CONCURRENCY));
    let remotes = Arc::new(StdMutex::new(serde_json::Map::new()));
    let mut handles = Vec::with_capacity(repositories.len());
    for repository in repositories {
        let semaphore = semaphore.clone();
        let remotes = remotes.clone();
        handles.push(tokio::spawn(async move {
            let _permit = match semaphore.acquire_owned().await {
                Ok(permit) => permit,
                Err(_) => return,
            };
            let path = std::path::Path::new(&repository.path);
            // Only a settled check (`Some`) is recorded; `None` (3s timeout) is left out.
            if let Some(kind) = repository_remote(path).await {
                let value = serde_json::to_value(kind)
                    .expect("RepositoryRemoteKind is always JSON-serialisable");
                remotes
                    .lock()
                    .expect("remotes mutex poisoned")
                    .insert(repository.id, value);
            }
        }));
    }

    let wait_all = async {
        for handle in &mut handles {
            // A `JoinError` only means that repository contributes nothing; keep awaiting the rest.
            let _ = handle.await;
        }
    };
    if tokio::time::timeout(REMOTE_DEADLINE, wait_all)
        .await
        .is_err()
    {
        for handle in &handles {
            handle.abort();
        }
    }

    let collected = remotes.lock().expect("remotes mutex poisoned").clone();
    Value::Object(collected)
}

/// A second `repositories.remotes` call during a sweep shares its result via `OnceCell`.
/// `StdMutex` suffices: the lock is never held across an await.
static REMOTES_IN_FLIGHT: LazyLock<StdMutex<Option<Arc<OnceCell<Value>>>>> =
    LazyLock::new(|| StdMutex::new(None));

pub fn repositories_remotes(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let cell = {
            let mut in_flight = REMOTES_IN_FLIGHT
                .lock()
                .expect("remotes in-flight mutex poisoned");
            match in_flight.as_ref() {
                Some(existing) => existing.clone(),
                None => {
                    let fresh = Arc::new(OnceCell::new());
                    *in_flight = Some(fresh.clone());
                    fresh
                }
            }
        };
        let repositories = state.registry.lock().await.snapshot().repositories;
        let result = cell
            .get_or_init(|| async move {
                let computed = remotes_bounded(repositories).await;
                // Clear the slot once settled so the next call starts a fresh sweep.
                *REMOTES_IN_FLIGHT
                    .lock()
                    .expect("remotes in-flight mutex poisoned") = None;
                computed
            })
            .await;
        Ok(result.clone())
    })
}

pub fn repositories_branches(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = required_str(&args, 0, "repositories.branches expects a string id")?;
        let repository = find_repository(&state, &id).await?;
        let branches = list_branches(std::path::Path::new(&repository.path))
            .await
            .map_err(map_git_error)?;
        let sessions = state
            .registry
            .lock()
            .await
            .snapshot()
            .sessions
            .into_iter()
            .filter(|s| s.repository_id == repository.id)
            .collect::<Vec<_>>();
        let entries = branch_entries(branches, &repository.default_branch, &sessions);
        Ok(serde_json::to_value(entries).expect("BranchEntry is always JSON-serialisable"))
    })
}

pub fn repositories_pick_folder(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let app_handle = state
            .app_handle
            .lock()
            .expect("app_handle mutex poisoned")
            .clone();
        let Some(app_handle) = app_handle else {
            return Ok(Value::Null);
        };
        let folder =
            tokio::task::spawn_blocking(move || app_handle.dialog().file().blocking_pick_folder())
                .await
                .map_err(|err| IpcError::new("unsupported", err.to_string()))?;
        let value = match folder.and_then(|path| path.into_path().ok()) {
            Some(path) => Value::String(path.to_string_lossy().into_owned()),
            None => Value::Null,
        };
        Ok(value)
    })
}

pub fn repositories_user_name(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = required_str(&args, 0, "repositories.userName expects a string id")?;
        let repository = find_repository(&state, &id).await?;
        let name = resolve_user_name(&repository.id, std::path::Path::new(&repository.path)).await;
        Ok(Value::String(name))
    })
}

#[cfg(test)]
#[path = "repositories_tests.rs"]
mod tests;
