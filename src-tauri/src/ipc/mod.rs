// The one Tauri command's dispatch table (FR-006, FR-007): routes a `refract_request(channel,
// args)` call to the registered handler for `channel`, or the `unsupported` envelope if nothing
// is registered for it yet. `lib.rs`'s `refract_request` command is the only caller of
// `Dispatcher::dispatch`; every other module (`omp`, `session`, `store`, `git`) registers its own
// channels into the same `Dispatcher` via `register_handlers` as it is built out, so this file
// never needs to change shape again once the dispatch mechanism itself is right.
//
// Phase 2(b) (tasks.md T013 to T019): widens `AppState` to hold the real, `Arc`-shared
// `RegistryStore`/`SettingsStore` (replacing the Phase 1 scaffold's minimal, non-validating
// `read_settings`/`read_bootstrap_theme` outright) and a slot for a `tauri::AppHandle` --
// `lib.rs`'s own `setup` closure fills it in once the window exists, for Phase 3's event
// emission (`events::emit` needs a live `AppHandle`, which does not exist until `setup` runs).

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;

use crate::git::git::GitError;
use crate::store::registry::{RegistryStore, RegistryStoreError};
use crate::store::settings::SettingsStore;

pub mod accounts;
pub mod attachments;
pub mod chat;
pub mod clipboard;
pub mod conversations;
pub mod file_explorer;
pub mod files;
pub mod model;
pub mod model_roles;
pub mod pull_requests;
pub mod readiness;
pub mod repositories;
pub mod sessions_agent;
pub mod sessions_lifecycle;
pub mod settings;
pub mod side_chat;
pub mod theme;

/// Shared state every registered handler receives. `registry`/`settings` are each behind their
/// own `Arc<tokio::sync::Mutex<_>>` -- one lock per store, not one lock for both, so a slow
/// repository write never blocks an unrelated `settings.get` -- and that per-store lock is also
/// what lets `store::atomic_json`'s own write skip the TS `atomicJson.ts`'s per-file write queue
/// (see that module's own doc comment): every write to a given store's file already goes through
/// the one `RegistryStore`/`SettingsStore` instance behind this one lock, so at most one write is
/// ever in flight for it. `app_handle` is `None` until `lib.rs`'s `setup` closure runs (Phase 3's
/// event emission is the first reader); behind a plain `std::sync::Mutex` since it is only ever
/// read-then-cloned, never held across an `.await`. `session_manager` (Phase 3, tasks.md T029)
/// is the one `session::SessionManager` every agent-backed handler (`sessions.open`/
/// `.stopAgent`/`.setVisible`, `conversations.startNew`/`.open`, every `chat.*` channel)
/// dispatches into; it shares this SAME `registry`/`settings` pair, never a second copy, so a
/// registry-only handler and an agent-backed one never disagree about the Session row.
#[derive(Clone)]
pub struct AppState {
    pub data_dir: PathBuf,
    pub registry: Arc<AsyncMutex<RegistryStore>>,
    pub settings: Arc<AsyncMutex<SettingsStore>>,
    pub app_handle: Arc<StdMutex<Option<tauri::AppHandle>>>,
    pub session_manager: Arc<crate::session::SessionManager>,
}

/// The exact shape `src/shared/ipc.ts`'s `IpcError` serialises to inside the `Result<T>`
/// envelope's `error` field.
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
/// A plain `fn` (not a closure) so each handler is defined as an ordinary top-level `async fn`
/// wrapped in `Box::pin` at the call site -- no captured state beyond the `AppState`/`Vec<Value>`
/// arguments every handler already receives.
pub type Handler = fn(AppState, Vec<Value>) -> HandlerFuture;

/// Routes a channel string to its registered handler, or the `unsupported` envelope (FR-007) if
/// nothing is registered for it yet -- every milestone-1 channel not implemented by this scaffold
/// (`parity.md`'s full table) falls through to this branch until its owning module registers it.
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

    /// Always resolves (never rejects the frontend's `invoke` promise): the `Result<T>` envelope
    /// itself carries success/failure, exactly as every `ipcMain.handle` in the Electron build
    /// does for `src/preload/index.ts`'s `request<T>` helper.
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
        // Security/perf: never log the envelope itself -- `sessions.open`/`conversations.open`
        // carry the whole transcript (prompts, tool output, secrets) in `value`. Only the
        // channel name and the outcome (`ok`, or the error code) are safe and cheap to log.
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

/// Registers every channel this build implements (tasks.md T013 to T029, `parity.md`'s
/// milestone-1 set), by calling exactly one `<module>::register(dispatcher)` per module (issue
/// #784, "Pre-declare per-lane Rust files"): each module owns its own `dispatcher.register(...)`
/// calls, so a lane adds a channel inside its own file and this function gains one new call,
/// never a second pass over another lane's registrations. Milestone-1 channels registered today:
/// `settings.get`/`settings.setApprovalMode` (Phase 2(b)), the registry-only
/// `repositories.*`/`sessions.{list,create,rename}`/`conversations.list` channels (Phase 2(b)),
/// `clipboard.writeText`/`readiness.check` (Phase 1), and the agent-backed `sessions.{open,
/// stopAgent,setVisible}`, `conversations.{startNew,open}`, and every `chat.*` channel (Phase 3,
/// tasks.md T024 to T026) -- each now dispatches into the live `session::SessionManager`
/// `AppState::session_manager` carries. `settings.*`, `theme.*`, `modelRoles.*`, and
/// `window.popupMenu` (lane R8, #791) are now also fully wired. Every other module registered
/// below (`accounts`, `attachments`, `file_explorer`, `files`, `pull_requests`, `side_chat`) is
/// an empty, pre-declared stub: its `register` is a no-op until that lane lands.
pub fn register_handlers(dispatcher: &mut Dispatcher) {
    settings::register(dispatcher);
    readiness::register(dispatcher);
    repositories::register(dispatcher);
    sessions_lifecycle::register(dispatcher);
    sessions_agent::register(dispatcher);
    conversations::register(dispatcher);
    chat::register(dispatcher);
    clipboard::register(dispatcher);
    file_explorer::register(dispatcher);
    files::register(dispatcher);
    pull_requests::register(dispatcher);
    accounts::register(dispatcher);
    attachments::register(dispatcher);
    side_chat::register(dispatcher);
    theme::register(dispatcher);
    model_roles::register(dispatcher);
    model::register(dispatcher);
    crate::shell::menu::register(dispatcher);
}

// ---------------------------------------------------------------------------
// Shared handler helpers (the Rust equivalent of `src/main/ipc/util.ts`'s own
// `invalidArgument`/`notFound`/`mapStoreThrown`).
// ---------------------------------------------------------------------------

pub fn invalid_argument(message: impl Into<String>) -> IpcError {
    IpcError::new("invalid-argument", message)
}

pub fn not_found(message: impl Into<String>) -> IpcError {
    IpcError::new("not-found", message)
}

/// Mirrors `ipc/util.ts`'s own `mapStoreThrown`'s `GitError` branch.
pub fn map_git_error(err: GitError) -> IpcError {
    IpcError::new(err.code.as_str(), err.message)
}

/// Mirrors `ipc/util.ts`'s own `mapStoreThrown`'s `RegistryError` branch, plus its catch-all
/// (any error that is not a recognised typed error maps to the `git-failed` fallback code) for
/// the `Io` variant -- a `registry.json` write failure is not a git error at all, but the TS
/// catch-all maps it to that same code regardless, since it never recognises anything beyond
/// `GitError`/`RegistryError`/`GhError`.
pub fn map_registry_error(err: RegistryStoreError) -> IpcError {
    match err {
        RegistryStoreError::Registry(e) => IpcError::new(e.code.as_str(), e.message),
        RegistryStoreError::Io(e) => IpcError::new("git-failed", e.to_string()),
    }
}

/// Mirrors `ipc/util.ts`'s own `mapSessionThrown`: `AgentError::code` is NOT always one of
/// `src/shared/ipc.ts`'s `IpcErrorCode` values -- `SessionAgent::launch`'s own internal
/// bookkeeping reasons `start-failed`/`not-started` are Session `stopReason`s (data-model.md),
/// never meant to cross the wire as an IPC error code -- so an unrecognised code falls back to
/// `reattach-failed`, exactly like `mapSessionThrown`'s own catch-all branch (code-review
/// finding, 2026-10-13: `conversations.startNew`/`.open` used to pass `err.code` straight
/// through for the `start_with_conversation` path, which can return either of those two).
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

/// Reads one positional string argument (`args[index]`), the Rust equivalent of destructuring
/// `ipcMain.handle`'s own `(_event, ...args)` callback parameters. Returns `None` for a missing
/// or non-string argument alike, so every call site can fold both into one `invalid_argument`.
pub fn arg_str(args: &[Value], index: usize) -> Option<&str> {
    args.get(index).and_then(Value::as_str)
}

/// `new Date().toISOString()`'s Rust equivalent, used by `repositories.add`/`sessions.create` to
/// stamp `addedAt`/`createdAt`/`lastActivityAt`. No `chrono`/`time` crate dependency (neither is
/// in this build's `Cargo.toml`): a manual proleptic-Gregorian civil-date conversion (Howard
/// Hinnant's well-known `civil_from_days` algorithm), UTC only.
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
