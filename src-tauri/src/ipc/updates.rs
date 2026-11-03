// IPC handlers for `updates.*` (#794). `on_state` callbacks broadcast `updates:state-changed` at
// each persisted transition, so the store lock is never held across a network call.

use serde_json::Value;
use tauri::Manager;

use crate::updates::checker;
use crate::updates::installer::{self, UpdateErrorCode};
use crate::updates::state::{SharedUpdateState, UpdatePhase, UpdateState};

use super::{AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("updates.check", updates_check);
    d.register("updates.getState", updates_get_state);
    d.register("updates.install", updates_install);
    d.register("updates.installNow", updates_install_now);
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

/// `installerPath` is main-only state; it is stripped from every renderer-facing `UpdateState`.
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

/// Background lifecycle (#883): the startup check, then a 4-hour periodic check, each
/// transition broadcast to the renderer.
pub async fn run_update_lifecycle(
    session_manager: std::sync::Arc<crate::session::SessionManager>,
    update_state: SharedUpdateState,
    data_dir: std::path::PathBuf,
    current_version: String,
) {
    let on_state = move |state: &UpdateState| {
        session_manager.emit_updates_state_changed(&to_value(state));
    };
    crate::updates::run_startup_update_check(&update_state, &data_dir, &current_version, &on_state)
        .await;
    crate::updates::run_periodic_update_checks(
        update_state,
        data_dir,
        current_version,
        crate::updates::check_interval(),
        on_state,
    )
    .await;
}

/// Builds the `on_state` broadcaster wrapping `session_manager.emit_updates_state_changed`.
fn broadcaster(state: &AppState) -> impl Fn(&UpdateState) + Send + Sync {
    let session_manager = state.session_manager.clone();
    move |update_state: &UpdateState| {
        session_manager.emit_updates_state_changed(&to_value(update_state));
    }
}

/// User-initiated: `automatic: false` lets the check re-run even from a persisted `Failed` phase.
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

/// "Update now" (#883): needs a `Downloaded` installer, flags a relaunch, then quits so the
/// `ExitRequested` hook stops agents, re-verifies the installer and installs.
fn updates_install_now(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let store_handle = store_handle(&state)?;
        let phase = store_handle.lock().await.get().phase;
        if phase != UpdatePhase::Downloaded {
            return Err(IpcError::new(
                "update-unavailable",
                "No downloaded update is ready to install.",
            ));
        }
        let app_handle = state
            .app_handle
            .lock()
            .expect("app_handle mutex poisoned")
            .clone();
        let Some(app_handle) = app_handle else {
            return Err(IpcError::new("unsupported", "No window yet"));
        };
        let updates_dir = state.data_dir.join("updates");
        if let Err((code, reason)) =
            crate::updates::verify_downloaded_installer(&store_handle, &updates_dir).await
        {
            let code = match code {
                UpdateErrorCode::UpdateUnavailable => "update-unavailable",
                UpdateErrorCode::ChecksumMismatch => "checksum-mismatch",
            };
            return Err(IpcError::new(code, reason));
        }
        // Declining leaves the downloaded update in place, so the user can choose "Update now" again.
        if !crate::shell::quit_guard::confirm_quit(&app_handle).await {
            return Ok(Value::Null);
        }
        crate::updates::request_restart_after_install();
        app_handle.exit(0);
        Ok(Value::Null)
    })
}
