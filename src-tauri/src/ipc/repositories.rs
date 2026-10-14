// IPC handlers for `repositories.*` (contracts/ipc.md "Repositories", tasks.md T017). The
// milestone-1 subset (`parity.md`): `.list`, `.add`, `.remove`, `.branches`, `.pickFolder`,
// `.userName`, plus `.rename` and `.remotes` (lane R2, issue #785), which port
// `renameRepository.ts`'s `renameRepositoryCore` and `git/remote.ts`'s `repositoryRemote`
// respectively.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex as StdMutex};

use serde::Serialize;
use serde_json::Value;
use tauri_plugin_dialog::DialogExt;

use crate::git::git::{git_raw, repo_info};
use crate::git::remote::repository_remote;
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
    d.register("repositories.rename", repositories_rename);
    d.register("repositories.branches", repositories_branches);
    d.register("repositories.remotes", repositories_remotes);
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

/// Issue #480 point 5 validation rules, ported from `src/shared/repositoryName.ts` (no
/// equivalent exists yet in this crate): "trimmed, not empty, a sensible maximum (60
/// characters), no control characters." An empty (after trimming) name is not an error here --
/// the caller resets it to the folder's own basename instead (`resolve_repository_name`).
const MAX_REPOSITORY_NAME_LENGTH: usize = 60;

/// `repositoryName.ts`'s own `\p{Cf}` (Unicode "Format") ranges, hand-enumerated since no
/// Unicode-category crate is a dependency of this build: bidi overrides/isolates, zero-width/
/// format characters (including the BOM), and the handful of rarer format controls the full
/// category also covers. `\p{Cc}` (control) is `char::is_control`, which matches it exactly
/// (`\x00`-`\x1f`, `\x7f`-`\x9f`); `\u2028`/`\u2029` (line/paragraph separator) sit outside both
/// categories and are checked for explicitly, same as the TS regex.
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

/// Returns an error message for an invalid non-empty name, or `None` when `trimmed` is
/// acceptable to store as-is (an empty string is always acceptable). ZWNJ/ZWJ (`\u200C`/
/// `\u200D`) are excluded from the control-character test -- required for legitimate text (emoji
/// ZWJ sequences, joining letters in Persian/Arabic/Indic scripts), not spoofing/invisible text.
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

/// Point 4: clearing the field and committing resets the display name back to the folder's own
/// basename. A name made of only ZWNJ/ZWJ, or one of those joiners flanked only by whitespace, is
/// exactly as blank as an all-whitespace name and resets the same way (`repositoryName.ts`'s own
/// `resolveRepositoryName`, quality-gate cycles 3 and 5).
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
        let id = match arg_str(&args, 0) {
            Some(id) => id.to_string(),
            None => {
                return Err(invalid_argument(
                    "repositories.rename expects (id, name) strings",
                ))
            }
        };
        let name = match arg_str(&args, 1) {
            Some(name) => name.to_string(),
            None => {
                return Err(invalid_argument(
                    "repositories.rename expects (id, name) strings",
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
        let trimmed = name.trim();
        // Quality-gate fix (cycle 2, ported): no channel-name prefix on this message -- it is
        // shown inline in the rename field's own alert text, never a toast.
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
        // Same placeholder `repositories.add` already returns rather than computing the real
        // remote inline (`repositories.remotes` is the dedicated, bounded call for that).
        Ok(with_unknown_remote(&updated))
    })
}

pub fn repositories_remotes(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let repositories = state.registry.lock().await.snapshot().repositories;
        let mut remotes = serde_json::Map::new();
        // Sequential, not the TS worker-pool/concurrency-cap: an acceptable simplification given
        // this build has no shared-deadline pool yet -- each `repository_remote` call is already
        // bounded by its own 3s timeout, so the loop stays bounded too, just slower for many
        // repositories. A future `tokio::spawn`-per-repository pool is a reasonable follow-up.
        for repository in &repositories {
            let path = std::path::Path::new(&repository.path);
            // Only a genuinely settled check (`Some`) is recorded -- `None` means this
            // repository's own timeout fired, so the caller keeps whatever value it already had.
            if let Some(kind) = repository_remote(path).await {
                let value: Value = serde_json::to_value(kind)
                    .expect("RepositoryRemoteKind is always JSON-serialisable");
                remotes.insert(repository.id.clone(), value);
            }
        }
        Ok(Value::Object(remotes))
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
