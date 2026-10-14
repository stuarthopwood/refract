// IPC handlers for `app.*` (contracts/ipc.md "Release notes", spec 006 "Updates" -- lane R11b,
// issue #794). `app.openReleaseNotes` was already specified (spec 008 FR-023) and already
// implemented on Electron (`src/main/ipc/accounts.ts`) and already wired through
// `src/tauri-bridge/index.ts`, but this Rust build never registered a handler for it -- every
// call against this build has returned `unsupported` since milestone 1. `app.getVersion` is new
// in this spec (data-model.md "Release": `UpdateState.availableVersion`/the status bar badge
// compare against it); both channels are small enough, and similar enough (both read the running
// build's own identity off the live `tauri::AppHandle`), to land together in one file rather than
// split across two near-empty ones.

use serde_json::Value;
use tauri_plugin_opener::OpenerExt;

use super::{AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("app.getVersion", app_get_version);
    d.register("app.openReleaseNotes", app_open_release_notes);
}

/// The running build's own version (`tauri::AppHandle::package_info`, which reads
/// `tauri.conf.json`'s `version` field at build time -- the same value `src-tauri/Cargo.toml`'s
/// `[package] version` is kept in sync with), for the update badge and for comparing against a
/// release's `UpdateState.availableVersion`.
pub fn app_get_version(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let app_handle = state
            .app_handle
            .lock()
            .expect("app_handle mutex poisoned")
            .clone();
        let Some(app_handle) = app_handle else {
            return Err(IpcError::new("unsupported", "No window yet"));
        };
        Ok(Value::String(app_handle.package_info().version.to_string()))
    })
}

/// Port of `src/main/ipc/accounts.ts`'s own `app.openReleaseNotes` handler: opens the installed
/// version's GitHub release page in the system browser via the same bounded opener plugin every
/// other external link in this build already goes through (`externalLinks.ts`'s own
/// `plugin:opener|open_url` call, here invoked from the Rust side instead of the renderer);
/// never opened inside an app window. Fire-and-forget, same as the Electron port: a failure to
/// launch the system browser is logged, never surfaced as an `IpcError` (there is nothing more
/// actionable the renderer could do with it).
pub fn app_open_release_notes(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let app_handle = state
            .app_handle
            .lock()
            .expect("app_handle mutex poisoned")
            .clone();
        let Some(app_handle) = app_handle else {
            return Ok(Value::Null);
        };
        let version = app_handle.package_info().version.to_string();
        let url = format!("https://github.com/stuarthopwood/refract/releases/tag/v{version}");
        if let Err(err) = app_handle.opener().open_url(url, None::<&str>) {
            log::error!("app.openReleaseNotes: failed to open the system browser: {err}");
        }
        Ok(Value::Null)
    })
}
