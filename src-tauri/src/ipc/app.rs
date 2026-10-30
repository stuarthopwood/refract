// `app.openReleaseNotes` is registered by `ipc::accounts`; do not re-register it here, since
// duplicate registrations race in `Dispatcher::register`.

use serde_json::Value;

use super::{AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("app.getVersion", app_get_version);
}

/// The running build's version, for the update badge.
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
