// "Save image..." for the Mermaid export (#471, #1454): kept out of the clipboard module because it writes a file, not the clipboard.

use serde_json::Value;
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use super::clipboard::decode_png_bytes;
use super::{AppState, Dispatcher, HandlerFuture, IpcError};

/// One save at a time, so two native dialogs never stack and two writes never race.
static SAVE_LOCK: Mutex<()> = Mutex::const_new(());

/// A bare file name ending in `.png`: separators, control characters and reserved characters are dropped.
fn sanitise_file_name(raw: Option<&str>) -> String {
    let cleaned: String = raw
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c))
        .collect();
    let stem = cleaned.trim().trim_matches('.').trim_end_matches(".png");
    let stem = stem.trim().trim_matches('.');
    let stem: String = stem.chars().take(100).collect();
    let stem = stem.trim_end_matches([' ', '.']);
    if stem.is_empty() {
        "image.png".to_string()
    } else {
        let device = stem.split('.').next().unwrap_or("").to_ascii_uppercase();
        let reserved = matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((device.starts_with("COM") || device.starts_with("LPT"))
                && device.len() == 4
                && device.as_bytes()[3].is_ascii_digit()
                && device.as_bytes()[3] != b'0');
        if reserved {
            format!("_{stem}.png")
        } else {
            format!("{stem}.png")
        }
    }
}

pub fn register(d: &mut Dispatcher) {
    d.register("clipboard.saveImage", save_image);
}

/// The user picks the path in a native dialog; null when cancelled.
pub fn save_image(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let name = sanitise_file_name(args.get(1).and_then(Value::as_str));
        let bytes =
            tokio::task::spawn_blocking(move || decode_png_bytes(&args, "clipboard.saveImage"))
                .await
                .map_err(|err| IpcError::new("clipboard-failed", err.to_string()))??;
        let _guard = SAVE_LOCK.lock().await;
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
        let save_err = |err: std::io::Error| {
            IpcError::new(
                "clipboard-failed",
                format!("The image could not be saved: {err}"),
            )
        };
        // Write beside the target, then rename, so a failed write never leaves a truncated PNG.
        let mut temp_name = path.file_name().unwrap_or_default().to_os_string();
        temp_name.push(".refract-tmp");
        let temp = path.with_file_name(temp_name);
        // create_new refuses to follow or overwrite a pre-existing file or symlink at the temp path.
        let written = match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .await
        {
            Ok(mut file) => match file.write_all(&bytes).await {
                Ok(()) => file.flush().await,
                err => err,
            },
            Err(err) => return Err(save_err(err)),
        };
        if let Err(err) = written {
            let _ = tokio::fs::remove_file(&temp).await;
            return Err(save_err(err));
        }
        if let Err(err) = tokio::fs::rename(&temp, &path).await {
            let _ = tokio::fs::remove_file(&temp).await;
            return Err(save_err(err));
        }
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "image.png".to_string());
        Ok(Value::String(file_name))
    })
}
