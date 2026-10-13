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

pub mod clipboard;
pub mod conversations;
pub mod readiness;
pub mod repositories;
pub mod sessions;
pub mod settings;

/// Shared state every registered handler receives. `registry`/`settings` are each behind their
/// own `Arc<tokio::sync::Mutex<_>>` -- one lock per store, not one lock for both, so a slow
/// repository write never blocks an unrelated `settings.get` -- and that per-store lock is also
/// what lets `store::atomic_json`'s own write skip the TS `atomicJson.ts`'s per-file write queue
/// (see that module's own doc comment): every write to a given store's file already goes through
/// the one `RegistryStore`/`SettingsStore` instance behind this one lock, so at most one write is
/// ever in flight for it. `app_handle` is `None` until `lib.rs`'s `setup` closure runs (Phase 3's
/// event emission is the first reader); behind a plain `std::sync::Mutex` since it is only ever
/// read-then-cloned, never held across an `.await`.
#[derive(Clone)]
pub struct AppState {
    pub data_dir: PathBuf,
    pub registry: Arc<AsyncMutex<RegistryStore>>,
    pub settings: Arc<AsyncMutex<SettingsStore>>,
    pub app_handle: Arc<StdMutex<Option<tauri::AppHandle>>>,
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
        Self { code, message: message.into() }
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
        Self { handlers: HashMap::new() }
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
                Err(err) => serde_json::json!({ "ok": false, "error": { "code": err.code, "message": err.message } }),
            },
            None => serde_json::json!({
                "ok": false,
                "error": {
                    "code": "unsupported",
                    "message": format!("Not available in the Rust build yet: {channel}")
                }
            }),
        };
        log::debug!("refract_request {channel} -> {envelope}");
        envelope
    }
}

/// Registers every channel this slice implements (tasks.md T013 to T019, `parity.md`'s
/// milestone-1 set): `settings.get`/`settings.setApprovalMode` (completing the Phase 1 stub with
/// the real store), the registry-only `repositories.*`/`sessions.*`/`conversations.list`
/// channels, `clipboard.writeText`, and `readiness.check`. `sessions.open`/`.stopAgent`/
/// `.setVisible`, `conversations.startNew`/`.open`, and every `chat.*` channel are deliberately
/// left unregistered here -- they need the live `session::manager` Phase 3 provides, so an
/// unmodified renderer calling one of them today still gets the documented `unsupported`
/// envelope above, never a panic or a hang.
pub fn register_handlers(dispatcher: &mut Dispatcher) {
    dispatcher.register("settings.get", settings::settings_get);
    dispatcher.register("settings.setApprovalMode", settings::settings_set_approval_mode);
    dispatcher.register("readiness.check", readiness::readiness_check);
    dispatcher.register("repositories.list", repositories::repositories_list);
    dispatcher.register("repositories.add", repositories::repositories_add);
    dispatcher.register("repositories.remove", repositories::repositories_remove);
    dispatcher.register("repositories.branches", repositories::repositories_branches);
    dispatcher.register("repositories.pickFolder", repositories::repositories_pick_folder);
    dispatcher.register("repositories.userName", repositories::repositories_user_name);
    dispatcher.register("sessions.list", sessions::sessions_list);
    dispatcher.register("sessions.create", sessions::sessions_create);
    dispatcher.register("sessions.rename", sessions::sessions_rename);
    dispatcher.register("conversations.list", conversations::conversations_list);
    dispatcher.register("clipboard.writeText", clipboard::clipboard_write_text);
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
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
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
