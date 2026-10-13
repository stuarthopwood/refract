// IPC handler for `clipboard.writeText` (contracts/ipc.md "Clipboard", T069): the fallback a
// Copy-path button uses when the sandboxed renderer's own `navigator.clipboard.writeText` is
// refused. `tauri_plugin_clipboard_manager`'s `Clipboard::write_text` is a main-process API and
// needs no renderer permission, the same reasoning the Electron build's own `electron.clipboard`
// comment gives.

use serde_json::Value;
use tauri_plugin_clipboard_manager::ClipboardExt;

use super::{invalid_argument, AppState, HandlerFuture, IpcError};

pub fn clipboard_write_text(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let text = match args.first().and_then(Value::as_str) {
            Some(text) => text.to_string(),
            None => return Err(invalid_argument("clipboard.writeText expects a string")),
        };
        let app_handle = state.app_handle.lock().expect("app_handle mutex poisoned").clone();
        let Some(app_handle) = app_handle else {
            return Err(IpcError::new("clipboard-failed", "No window yet"));
        };
        tokio::task::spawn_blocking(move || app_handle.clipboard().write_text(text))
            .await
            .map_err(|err| IpcError::new("clipboard-failed", err.to_string()))?
            .map_err(|err| IpcError::new("clipboard-failed", err.to_string()))?;
        Ok(Value::Null)
    })
}
