// Routes `refract_request` channels to their handlers. `lib.rs` is the only caller of `dispatch`.
// `AppState::app_handle` is filled in by `setup`, since a live `AppHandle` only exists after setup.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;

use crate::git::git::GitError;
use crate::git::remote::{repository_remote, RepositoryRemoteKind};
use crate::store::registry::{RegistryStore, RegistryStoreError, Repository};
use crate::store::settings::SettingsStore;

pub mod accounts;
pub mod advisor_roster;
pub mod agent_tools;
pub mod app;
pub mod attachments;
pub mod chat;
pub mod chat_pause;
pub mod clipboard;
pub mod conversations;
pub mod copilot_plan;
pub mod debug;
pub mod file_attachments;
pub mod file_explorer;
pub mod files;
pub mod git_changes;
pub mod github_stack;
pub mod home;
pub mod image_save;
pub mod images;
pub mod issues;
pub mod item_refs;
pub mod model;
pub mod model_roles;
pub mod pull_requests;
pub mod readiness;
pub mod repositories;
pub mod repositories_clone;
pub mod repositories_color;
pub mod session_kickoff;
pub mod sessions_agent;
pub mod sessions_lifecycle;
pub mod sessions_visibility;
pub mod settings;
pub mod settings_alarms;
pub mod settings_animated_status_text;
pub mod settings_chat_row_density;
pub mod settings_code_ligatures;
pub mod settings_default_clone_folder;
pub mod settings_finished_turn_times;
pub mod settings_notification_sounds;
pub mod settings_scrollbar_map;
pub mod settings_stacked_pull_requests;
pub mod settings_status_style;
pub mod settings_typography;
pub mod side_chat;
pub mod spellcheck;
pub mod subagents;
pub mod theme;
pub mod themes;
pub mod token_guard;
pub mod updates;
pub mod usage;
pub mod usage_prefs;
pub mod working_mode;

/// Shared state passed to every handler. Each store has its own lock, so one slow write never
/// blocks another store. `session_manager` shares the same store instances, never copies.
#[derive(Clone)]
pub struct AppState {
    pub data_dir: PathBuf,
    pub registry: Arc<AsyncMutex<RegistryStore>>,
    pub settings: Arc<AsyncMutex<SettingsStore>>,
    pub app_handle: Arc<StdMutex<Option<tauri::AppHandle>>>,
    pub session_manager: Arc<crate::session::SessionManager>,
}

/// The `error` field of the `Result<T>` envelope, matching the renderer's `IpcError`.
#[derive(Debug)]
pub struct IpcError {
    pub code: &'static str,
    pub message: String,
}

impl IpcError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub type HandlerResult = Result<Value, IpcError>;
pub type HandlerFuture = Pin<Box<dyn Future<Output = HandlerResult> + Send>>;
/// A plain `fn` pointer, so each handler is an ordinary `async fn` wrapped in `Box::pin`.
pub type Handler = fn(AppState, Vec<Value>) -> HandlerFuture;

/// Routes a channel to its handler, or to the `unsupported` envelope if none is registered.
#[derive(Default)]
pub struct Dispatcher {
    handlers: HashMap<&'static str, Handler>,
}

impl Dispatcher {
    pub fn new() -> Self {
        Self {
            handlers: HashMap::new(),
        }
    }

    pub fn register(&mut self, channel: &'static str, handler: Handler) {
        self.handlers.insert(channel, handler);
    }

    /// Always resolves; success or failure travels in the `Result<T>` envelope, never a rejection.
    pub async fn dispatch(&self, channel: &str, state: AppState, args: Vec<Value>) -> Value {
        let envelope = match self.handlers.get(channel) {
            Some(handler) => match handler(state, args).await {
                Ok(value) => serde_json::json!({ "ok": true, "value": value }),
                Err(err) => {
                    serde_json::json!({ "ok": false, "error": { "code": err.code, "message": err.message } })
                }
            },
            None => serde_json::json!({
                "ok": false,
                "error": {
                    "code": "unsupported",
                    "message": format!("Not available in the Rust build yet: {channel}")
                }
            }),
        };
        // Never log the envelope: `value` can carry whole transcripts and secrets.
        match envelope.get("ok").and_then(Value::as_bool) {
            Some(true) => log::debug!("refract_request {channel} -> ok"),
            _ => {
                let code = envelope
                    .get("error")
                    .and_then(|error| error.get("code"))
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                log::debug!("refract_request {channel} -> err:{code}");
            }
        }
        envelope
    }
}

/// Registers every implemented channel by calling each module's `register` once. Modules that
/// are still stubs register nothing.
pub fn register_handlers(dispatcher: &mut Dispatcher) {
    settings::register(dispatcher);
    settings_animated_status_text::register(dispatcher);
    settings_code_ligatures::register(dispatcher);
    settings_notification_sounds::register(dispatcher);
    settings_scrollbar_map::register(dispatcher);
    settings_stacked_pull_requests::register(dispatcher);
    settings_typography::register(dispatcher);
    settings_alarms::register(dispatcher);
    settings_finished_turn_times::register(dispatcher);
    settings_status_style::register(dispatcher);
    settings_chat_row_density::register(dispatcher);
    debug::register(dispatcher);
    readiness::register(dispatcher);
    repositories::register(dispatcher);
    repositories_color::register(dispatcher);
    repositories_clone::register(dispatcher);
    settings_default_clone_folder::register(dispatcher);
    sessions_lifecycle::register(dispatcher);
    sessions_visibility::register(dispatcher);
    home::register(dispatcher);
    issues::register(dispatcher);
    item_refs::register(dispatcher);
    sessions_agent::register(dispatcher);
    conversations::register(dispatcher);
    chat::register(dispatcher);
    chat_pause::register(dispatcher);
    subagents::register(dispatcher);
    clipboard::register(dispatcher);
    image_save::register(dispatcher);
    spellcheck::register(dispatcher);
    file_explorer::register(dispatcher);
    git_changes::register(dispatcher);
    images::register(dispatcher);
    files::register(dispatcher);
    pull_requests::register(dispatcher);
    github_stack::register(dispatcher);
    accounts::register(dispatcher);
    attachments::register(dispatcher);
    file_attachments::register(dispatcher);
    side_chat::register(dispatcher);
    theme::register(dispatcher);
    themes::register(dispatcher);
    app::register(dispatcher);
    token_guard::register(dispatcher);
    agent_tools::register(dispatcher);
    advisor_roster::register(dispatcher);
    copilot_plan::register(dispatcher);
    usage::register(dispatcher);
    updates::register(dispatcher);
    model_roles::register(dispatcher);
    model::register(dispatcher);
    working_mode::register(dispatcher);
    crate::shell::menu::register(dispatcher);
    crate::shell::zoom::register(dispatcher);
}

pub fn invalid_argument(message: impl Into<String>) -> IpcError {
    IpcError::new("invalid-argument", message)
}

pub fn not_found(message: impl Into<String>) -> IpcError {
    IpcError::new("not-found", message)
}

/// Maps a git error to its IPC code.
pub fn map_git_error(err: GitError) -> IpcError {
    IpcError::new(err.code.as_str(), err.message)
}

/// Maps a registry error to its IPC code. Write failures fall back to `git-failed`.
pub fn map_registry_error(err: RegistryStoreError) -> IpcError {
    match err {
        RegistryStoreError::Registry(e) => IpcError::new(e.code.as_str(), e.message),
        RegistryStoreError::Io(e) => IpcError::new("git-failed", e.to_string()),
    }
}

/// Maps an agent error to an IPC code. Unknown codes fall back to `reattach-failed`, since
/// `start-failed` and `not-started` are stop reasons, not wire codes.
pub fn map_agent_error(err: crate::session::AgentError) -> IpcError {
    const IPC_ERROR_CODES: &[&str] = &[
        "not-a-repo",
        "no-commits",
        "duplicate",
        "has-sessions",
        "git-failed",
        "worktree-failed",
        "base-missing",
        "path-too-long",
        "not-idle",
        "reattach-failed",
        "unknown-command",
        "unsupported-arguments",
        "branch-missing",
        "not-found",
        "invalid-argument",
        "prompt-failed",
        "agent-not-running",
        "worktree-missing",
        "file-missing",
        "outside-worktree",
        "clipboard-failed",
        "unsupported-image-type",
        "image-too-large",
        "invalid-theme",
        "gh-not-found",
        "gh-failed",
        "timeout",
        "account-not-found",
        "omp-probe-failed",
        "unsupported",
        "no-github-remote",
        "gh-unavailable",
        "rate-limited",
        "github-failed",
        "stale",
        "not-mergeable",
        "checkout-failed",
        "disabled",
        "session-archived",
    ];
    let code = if IPC_ERROR_CODES.contains(&err.code) {
        err.code
    } else {
        "reattach-failed"
    };
    IpcError::new(code, err.message)
}

/// Reads a string argument. Missing and non-string values both return `None`.
pub fn arg_str(args: &[Value], index: usize) -> Option<&str> {
    args.get(index).and_then(Value::as_str)
}

/// Reads a required string argument, or fails with an `invalid-argument` carrying `message`.
pub fn required_str(args: &[Value], index: usize, message: &str) -> Result<String, IpcError> {
    arg_str(args, index)
        .map(str::to_string)
        .ok_or_else(|| invalid_argument(message))
}

/// Looks up a repository by id, cloned out so the registry lock is not held.
pub async fn find_repository(state: &AppState, id: &str) -> Result<Repository, IpcError> {
    let registry = state.registry.lock().await;
    registry
        .get_repository(id)
        .cloned()
        .ok_or_else(|| not_found(format!("Project not found: {id}")))
}

/// Repository JSON with its remote recomputed inline; `repository_remote` caps itself at 3s and
/// `None` falls back to `unknown`.
pub async fn with_resolved_remote(repository: &Repository) -> Value {
    let remote = repository_remote(std::path::Path::new(&repository.path))
        .await
        .unwrap_or(RepositoryRemoteKind::Unknown);
    repositories::with_remote(repository, &remote)
}

/// UTC ISO-8601 timestamp. Uses a manual civil-date conversion, since the crate has no date dependency.
pub fn now_iso8601() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let millis = now.as_millis();
    let secs = (millis / 1000) as i64;
    let subsec_millis = (millis % 1000) as u32;
    format_unix_timestamp(secs, subsec_millis)
}

fn format_unix_timestamp(secs: i64, millis: u32) -> String {
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}
