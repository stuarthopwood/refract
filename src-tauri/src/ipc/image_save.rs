// "Save image..." for the Mermaid export (#471, #1454): kept out of the clipboard module because it writes a file, not the clipboard.

use serde_json::Value;
use tauri_plugin_dialog::DialogExt;

use super::clipboard::decode_png_bytes;
use super::{AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("clipboard.saveImage", save_image);
}

/// The user picks the path in a native dialog; null when cancelled.
pub fn save_image(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let name = args
            .get(1)
            .and_then(Value::as_str)
            .filter(|n| !n.is_empty() && n.len() <= 128 && !n.contains(['/', '\\']))
            .unwrap_or("image.png")
            .to_string();
        let bytes =
            tokio::task::spawn_blocking(move || decode_png_bytes(&args, "clipboard.saveImage"))
                .await
                .map_err(|err| IpcError::new("clipboard-failed", err.to_string()))??;
        let app_handle = state
            .app_handle
            .lock()
            .expect("app_handle mutex poisoned")
            .clone();
        let Some(app_handle) = app_handle else {
            return Err(IpcError::new("clipboard-failed", "No window yet"));
        };
        let picked = tokio::task::spawn_blocking(move || {
            app_handle
                .dialog()
                .file()
                .set_file_name(name)
                .add_filter("PNG image", &["png"])
                .blocking_save_file()
        })
        .await
        .map_err(|err| IpcError::new("clipboard-failed", err.to_string()))?;
        let Some(picked) = picked else {
            return Ok(Value::Null);
        };
        let path = picked.into_path().map_err(|_| {
            IpcError::new("clipboard-failed", "The chosen location is not a file path")
        })?;
        tokio::fs::write(&path, bytes).await.map_err(|err| {
            IpcError::new(
                "clipboard-failed",
                format!("The image could not be saved: {err}"),
            )
        })?;
        Ok(Value::String(path.to_string_lossy().into_owned()))
    })
}
