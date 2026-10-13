// IPC handlers for `repositories.*` (contracts/ipc.md "Repositories", tasks.md T017). Only the
// milestone-1 subset is ported (`parity.md`): `.list`, `.add`, `.remove`, `.branches`,
// `.pickFolder`, `.userName`. `.rename` and `.remotes` are `later`-milestone channels and stay
// unregistered -- neither this file nor `git::worktrees` ports `git/remote.ts` or
// `renameRepository.ts`, which only those two channels need.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex as StdMutex};

use serde::Serialize;
use serde_json::Value;
use tauri_plugin_dialog::DialogExt;

use crate::git::git::{git_raw, repo_info};
use crate::git::worktrees::{default_branch, list_branches};
use crate::store::registry::{Repository, Session, REPOSITORY_HAS_SESSIONS_MESSAGE};

use super::{
    arg_str, invalid_argument, map_git_error, map_registry_error, not_found, now_iso8601, AppState,
    Dispatcher, HandlerFuture, IpcError,
};

pub fn register(d: &mut Dispatcher) {
    d.register("repositories.list", repositories_list);
    d.register("repositories.add", repositories_add);
    d.register("repositories.remove", repositories_remove);
    d.register("repositories.branches", repositories_branches);
    d.register("repositories.pickFolder", repositories_pick_folder);
    d.register("repositories.userName", repositories_user_name);
}

/// `repositories.userName` (T072, FR-045): `git config user.name` in the repository's own
/// checkout, falling back to the Windows account name when git has none configured; cached per
/// repository id for the process lifetime so the "Answer:" avatar/name never re-shells out.
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

/// `os.userInfo().username`'s Rust equivalent: the logged-in Windows account name, read from the
/// environment rather than a new dependency (`whoami`/`os_info` are not in this build's
/// `Cargo.toml`) -- `USERNAME` is always set in a Windows process environment.
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

/// Base branch picker entries (FR-002, contracts/ipc.md `repositories.branches`): the default
/// branch first (when it still exists), then plain branches in git order, then branches owned by
/// one of this repository's Sessions, labelled with that Session's live display name and sorted
/// by it.
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

fn with_unknown_remote(repository: &Repository) -> Value {
    let mut value =
        serde_json::to_value(repository).expect("Repository is always JSON-serialisable");
    value
        .as_object_mut()
        .expect("Repository serialises to a JSON object")
        .insert(
            "remote".to_string(),
            serde_json::json!({ "kind": "unknown" }),
        );
    value
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
        let info = repo_info(std::path::Path::new(&repo_path))
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
        };
        state
            .registry
            .lock()
            .await
            .add_repository(repository.clone())
            .await
            .map_err(map_registry_error)?;
        Ok(with_unknown_remote(&repository))
    })
}

pub fn repositories_remove(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match arg_str(&args, 0) {
            Some(id) => id.to_string(),
            None => return Err(invalid_argument("repositories.remove expects a string id")),
        };
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

pub fn repositories_branches(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match arg_str(&args, 0) {
            Some(id) => id.to_string(),
            None => {
                return Err(invalid_argument(
                    "repositories.branches expects a string id",
                ))
            }
        };
        let repository = {
            let registry = state.registry.lock().await;
            let repository = registry
                .get_repository(&id)
                .ok_or_else(|| not_found(format!("Repository not found: {id}")))?;
            repository.clone()
        };
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
        let id = match arg_str(&args, 0) {
            Some(id) => id.to_string(),
            None => {
                return Err(invalid_argument(
                    "repositories.userName expects a string id",
                ))
            }
        };
        let repository = {
            let registry = state.registry.lock().await;
            registry
                .get_repository(&id)
                .ok_or_else(|| not_found(format!("Repository not found: {id}")))?
                .clone()
        };
        let name = resolve_user_name(&repository.id, std::path::Path::new(&repository.path)).await;
        Ok(Value::String(name))
    })
}
