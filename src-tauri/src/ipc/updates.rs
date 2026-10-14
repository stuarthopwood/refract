// IPC handlers for `updates.*` (contracts/ipc.md "Updates", spec 006 re-scoped onto the Tauri
// bundler -- lane R11b, issue #794). Broadcasts `updates:state-changed` via `on_state` callbacks
// threaded into `checker::check_for_updates`/`installer::download_update` themselves, so an
// intermediate `Checking`/`Downloading` transition is broadcast the moment it is persisted, not
// only once the whole (possibly multi-minute) call finally resolves (gate finding, PR #829
// round 1, perf HIGH: the store lock -- and so every broadcast -- used to be held by this file
// across the whole network call).

use serde_json::Value;
use tauri::Manager;

use crate::updates::checker;
use crate::updates::installer::{self, UpdateErrorCode};
use crate::updates::state::{SharedUpdateState, UpdateState};

use super::{AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("updates.check", updates_check);
    d.register("updates.getState", updates_get_state);
    d.register("updates.install", updates_install);
}

fn store_handle(state: &AppState) -> Result<SharedUpdateState, IpcError> {
    let app_handle = state
        .app_handle
        .lock()
        .expect("app_handle mutex poisoned")
        .clone();
    let Some(app_handle) = app_handle else {
        return Err(IpcError::new("unsupported", "No window yet"));
    };
    app_handle
        .try_state::<SharedUpdateState>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| IpcError::new("unsupported", "Update state not initialised yet"))
}

/// `installerPath` is main-only state (`install_on_quit`/`resolve_installing_state` both need
/// it); every renderer-facing copy of `UpdateState` -- this function's return value, used by
/// every handler below and by `lib.rs`'s own broadcast call sites -- has it stripped before it
/// ever crosses the IPC boundary (plan.md "never a ... file path").
pub fn to_renderer_state(state: &UpdateState) -> UpdateState {
    let mut rendered = state.clone();
    rendered.installer_path = None;
    rendered
}

fn to_value(state: &UpdateState) -> Value {
    serde_json::to_value(to_renderer_state(state)).expect("UpdateState is always JSON-serialisable")
}

fn current_version(state: &AppState) -> Result<String, IpcError> {
    let app_handle = state
        .app_handle
        .lock()
        .expect("app_handle mutex poisoned")
        .clone();
    let Some(app_handle) = app_handle else {
        return Err(IpcError::new("unsupported", "No window yet"));
    };
    Ok(app_handle.package_info().version.to_string())
}

/// Builds the `on_state` broadcaster `checker`/`installer` call at each persisted transition,
/// wrapping `session_manager.emit_updates_state_changed` (the only thing those lower modules
/// cannot reach directly without depending on `session`/IPC machinery themselves).
fn broadcaster(state: &AppState) -> impl Fn(&UpdateState) + Send + Sync {
    let session_manager = state.session_manager.clone();
    move |update_state: &UpdateState| {
        session_manager.emit_updates_state_changed(&to_value(update_state));
    }
}

/// User-initiated (contracts/ipc.md): `automatic: false` lets `check_for_updates` re-check even
/// from a persisted `Failed` phase (the status bar's own "Try again"), unlike `lib.rs`'s own
/// automatic startup call.
fn updates_check(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let version = current_version(&state)?;
        let store_handle = store_handle(&state)?;
        let on_state = broadcaster(&state);
        let result = checker::check_for_updates(&store_handle, false, &version, &on_state).await;
        Ok(to_value(&result))
    })
}

fn updates_get_state(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let store_handle = store_handle(&state)?;
        let store = store_handle.lock().await;
        Ok(to_value(&store.get()))
    })
}

fn updates_install(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let store_handle = store_handle(&state)?;
        let on_state = broadcaster(&state);
        let result = installer::download_update(&store_handle, &state.data_dir, &on_state).await;
        match result {
            Ok(()) => Ok(Value::Null),
            Err(err) => {
                let code = match err.code {
                    UpdateErrorCode::UpdateUnavailable => "update-unavailable",
                    UpdateErrorCode::ChecksumMismatch => "checksum-mismatch",
                };
                Err(IpcError::new(code, err.message))
            }
        }
    })
}
