// Fallback for when the sandboxed renderer's clipboard write is refused; the main process needs no permission.

use serde_json::Value;
use tauri_plugin_clipboard_manager::ClipboardExt;

use super::{invalid_argument, AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("clipboard.writeText", clipboard_write_text);
    d.register("clipboard.readText", clipboard_read_text);
}

/// Larger clipboard text is refused, not truncated, so a paste never silently loses data (#471).
const MAX_READ_BYTES: usize = 1024 * 1024;

/// Composer menu Paste (#471): the sandboxed renderer may refuse `navigator.clipboard.readText`.
pub fn clipboard_read_text(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let app_handle = state
            .app_handle
            .lock()
            .expect("app_handle mutex poisoned")
            .clone();
        let Some(app_handle) = app_handle else {
            return Err(IpcError::new("clipboard-failed", "No window yet"));
        };
        let text = tokio::task::spawn_blocking(move || app_handle.clipboard().read_text())
            .await
            .map_err(|_| IpcError::new("clipboard-failed", "The clipboard could not be read"))?
            .map_err(|_| IpcError::new("clipboard-failed", "The clipboard has no text"))?;
        if text.len() > MAX_READ_BYTES {
            return Err(IpcError::new(
                "clipboard-too-large",
                "The clipboard text is too large to paste (over 1 MB)",
            ));
        }
        Ok(Value::String(text))
    })
}

pub fn clipboard_write_text(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let text = match args.first().and_then(Value::as_str) {
            Some(text) => text.to_string(),
            None => return Err(invalid_argument("clipboard.writeText expects a string")),
        };
        let app_handle = state
            .app_handle
            .lock()
            .expect("app_handle mutex poisoned")
            .clone();
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
