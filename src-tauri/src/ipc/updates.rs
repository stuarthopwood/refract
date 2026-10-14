// IPC handlers for `updates.*` (contracts/ipc.md "Updates", spec 006 re-scoped onto the Tauri
// bundler -- lane R11b, issue #794). Broadcasts `updates:state-changed` on every mutating call
// here, the same "the handler that caused the transition also fires the broadcast" convention
// `ipc::settings::settings_set_approval_mode` already establishes for `settings:changed` --
// unlike the mined Electron prototype's own `UpdateStateStore.onChange` listener/pub-sub design
// (this build's `UpdateStateStore` has no listener registry at all; see `updates::state`'s own
// header), since every caller of `.update()` in this Rust port is already known and finite.

use std::sync::Arc;

use serde_json::Value;
use tauri::Manager;
use tokio::sync::Mutex as AsyncMutex;

use crate::updates::checker;
use crate::updates::installer::{self, UpdateErrorCode};
use crate::updates::state::UpdateState;

use super::{AppState, Dispatcher, HandlerFuture, IpcError};

/// The one `UpdateStateStore` instance for the process lifetime, `.manage()`d by `lib.rs`'s
/// `setup` closure (the same "managed Tauri state, not `AppState`" pattern
/// `shell::window_state::Tracker` already uses) -- `Handler`'s fixed `fn(AppState, Vec<Value>)`
/// signature has no slot for a second store, so this is reached through the live `AppHandle`
/// `AppState::app_handle` already carries, not a new `AppState` field (which would force every
/// OTHER lane's test helper that hand-builds an `AppState` to learn about this one's state too).
pub type SharedUpdateState = Arc<AsyncMutex<crate::updates::state::UpdateStateStore>>;

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

/// User-initiated (contracts/ipc.md): `automatic: false` lets `check_for_updates` re-check even
/// from a persisted `Failed` phase (the status bar's own "Try again"), unlike `lib.rs`'s own
/// automatic startup call.
fn updates_check(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let version = current_version(&state)?;
        let store_handle = store_handle(&state)?;
        let mut store = store_handle.lock().await;
        let result = checker::check_for_updates(&mut store, false, &version).await;
        drop(store);
        state
            .session_manager
            .emit_updates_state_changed(&to_value(&result));
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
        let mut store = store_handle.lock().await;
        // `download_update` persists `Downloading` itself, immediately, before the (possibly
        // long) download even starts -- broadcasting the post-call state below therefore covers
        // both the immediate `Downloading` transition's own effect (visible once this task is
        // next polled) and the final `Downloaded`/`Failed` outcome. A finer-grained
        // "broadcast every intermediate persisted state" would need `updates::state`'s own
        // listener registry back, which this port deliberately does not carry (see this file's
        // own header) -- this one broadcast after the call still reports the FINAL `UpdateState`
        // faithfully, which is all `updates:state-changed`'s documented purpose requires.
        let result = installer::download_update(&mut store, &state.data_dir).await;
        let rendered = to_value(&store.get());
        drop(store);
        state.session_manager.emit_updates_state_changed(&rendered);
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
