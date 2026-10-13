// The one Tauri command's dispatch table (FR-006, FR-007): routes a `refract_request(channel,
// args)` call to the registered handler for `channel`, or the `unsupported` envelope if nothing
// is registered for it yet. `lib.rs`'s `refract_request` command is the only caller of
// `Dispatcher::dispatch`; every other module (`omp`, `session`, `store`, `git`) registers its own
// channels into the same `Dispatcher` via `register_handlers` as it is built out, so this file
// never needs to change shape again once the dispatch mechanism itself is right.

use std::collections::HashMap;
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use serde_json::{json, Value};

/// Shared state every registered handler receives. Only the data directory (FR-014) for now --
/// cheap to clone (a single `PathBuf`) -- widened as later slices add live state (the session
/// registry, running agents, an in-memory settings cache).
#[derive(Clone)]
pub struct AppState {
    pub data_dir: PathBuf,
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
                Ok(value) => json!({ "ok": true, "value": value }),
                Err(err) => json!({ "ok": false, "error": { "code": err.code, "message": err.message } }),
            },
            None => json!({
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

/// Registers every channel this scaffold currently implements: just `settings.get` for now, so
/// the renderer's own startup `settings.get()` call (spec 004/007/012/013 store init) resolves
/// instead of staying permanently `unsupported` and leaving the renderer stuck. Every other
/// milestone-1 channel (FR-012) is registered by its own owning module (`omp`, `session`,
/// `store`, `git`) in a later slice -- this function is the one place a later slice adds its own
/// `dispatcher.register(...)` calls.
pub fn register_handlers(dispatcher: &mut Dispatcher) {
    dispatcher.register("settings.get", settings_get);
}

fn settings_get(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move { Ok(read_settings(&state.data_dir)) })
}

/// Default `Settings` row, matching `src/main/store/settings.ts`'s own `SettingsStore.open`
/// fallback object exactly (field for field), overlaid with whatever top-level keys
/// `settings.json` already has on disk, if it parses as a JSON object. This is a minimal, non-
/// validating read -- no per-field migration/lazy-correction of an invalid `theme`/`split`/etc,
/// the way the real `SettingsStore` does -- just enough to answer `settings.get` and boot the
/// renderer themed (FR-010, FR-011) without crashing; the real `store::settings` port (plan.md
/// Project Structure) replaces this outright in a later slice.
pub fn read_settings(data_dir: &Path) -> Value {
    let defaults = default_settings();
    let file = data_dir.join("settings.json");
    let Ok(bytes) = fs::read(&file) else {
        return defaults;
    };
    let Ok(Value::Object(saved)) = serde_json::from_slice::<Value>(&bytes) else {
        return defaults;
    };
    let Value::Object(mut merged) = defaults else {
        unreachable!("default_settings always returns an object");
    };
    for (key, value) in saved {
        merged.insert(key, value);
    }
    Value::Object(merged)
}

/// Reads just the persisted `theme` id for the pre-window theme-bootstrap initialization script
/// (FR-010), falling back to `"dark"` exactly as `SettingsStore.open`'s own FR-013 migration
/// does for a missing or invalid key -- never trusts anything other than the small, fixed set of
/// known theme ids (`src/shared/themes.ts`'s `isThemeId`).
pub fn read_bootstrap_theme(data_dir: &Path) -> String {
    match read_settings(data_dir).get("theme") {
        Some(Value::String(id)) if is_known_theme_id(id) => id.clone(),
        _ => "dark".to_string(),
    }
}

fn is_known_theme_id(id: &str) -> bool {
    matches!(id, "dark" | "dark-high-contrast" | "obsidian")
}

fn default_settings() -> Value {
    json!({
        "version": 1,
        "approvalMode": "ask",
        "sessionReadout": {
            "changes": true,
            "context-usage": true,
            "turn-time": true,
            "current-time": false,
            "pull-request": true,
            "subagents": true,
            "todo-progress": true
        },
        "split": null,
        "theme": "dark",
        "watermarkEnabled": true,
        "transcriptDisplay": { "thinking": true, "toolCalls": true },
        "showSampleData": false,
        "detectImagePathsOnPaste": true
    })
}
