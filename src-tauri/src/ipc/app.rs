// IPC handler for `app.getVersion` (lane R11b, issue #794, spec 006 "Updates" data-model.md
// "Release": `UpdateState.availableVersion`/the status bar badge compare against it). Note:
// `app.openReleaseNotes` is a separate, pre-existing channel (spec 008 FR-023) now implemented
// by lane R9's `ipc::accounts` module (`src/main/ipc/accounts.ts` port) -- it is NOT this file's
// concern; do not re-register it here (the two registrations would silently race in
// `Dispatcher::register`'s `HashMap::insert`, whichever module's `register()` runs last in
// `ipc::register_handlers` winning).

use serde_json::Value;

use super::{AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("app.getVersion", app_get_version);
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
