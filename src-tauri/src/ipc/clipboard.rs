// Fallback for when the sandboxed renderer's clipboard write is refused; the main process needs no permission.

use serde_json::Value;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;

use super::{invalid_argument, AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("clipboard.writeText", clipboard_write_text);
    d.register("clipboard.readText", clipboard_read_text);
    d.register("clipboard.writeImage", clipboard_write_image);
    d.register("clipboard.saveImage", clipboard_save_image);
}

/// Larger images are refused; a 2x Mermaid export is far below this (#471).
const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_IMAGE_PIXELS: u64 = 16_000_000;
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

fn decode_png_bytes(args: &[Value], method: &str) -> Result<Vec<u8>, IpcError> {
    use base64::Engine;
    let Some(encoded) = args.first().and_then(Value::as_str) else {
        return Err(invalid_argument(format!("{method} expects a base64 PNG")));
    };
    if encoded.len() > MAX_IMAGE_BYTES * 4 / 3 + 4 {
        return Err(IpcError::new("clipboard-too-large", "The image is too large"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| invalid_argument(format!("{method} expects a base64 PNG")))?;
    if !bytes.starts_with(&PNG_SIGNATURE) {
        return Err(invalid_argument(format!("{method} expects a PNG image")));
    }
    Ok(bytes)
}

fn png_to_rgba(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), IpcError> {
    let bad = || IpcError::new("clipboard-failed", "The image could not be read");
    let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
        .read_info()
        .map_err(|_| bad())?;
    let info = reader.info();
    if u64::from(info.width) * u64::from(info.height) > MAX_IMAGE_PIXELS {
        return Err(IpcError::new("clipboard-too-large", "The image is too large"));
    }
    let mut buf = vec![0; reader.output_buffer_size().ok_or_else(bad)?];
    let frame = reader.next_frame(&mut buf).map_err(|_| bad())?;
    buf.truncate(frame.buffer_size());
    let rgba = match frame.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => buf
            .chunks_exact(3)
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect(),
        _ => return Err(bad()),
    };
    Ok((rgba, frame.width, frame.height))
}

/// Mermaid "Copy as image" (#471): the renderer rasterises the diagram and sends a PNG.
pub fn clipboard_write_image(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let bytes = decode_png_bytes(&args, "clipboard.writeImage")?;
        let app_handle = state
            .app_handle
            .lock()
            .expect("app_handle mutex poisoned")
            .clone();
        let Some(app_handle) = app_handle else {
            return Err(IpcError::new("clipboard-failed", "No window yet"));
        };
        tokio::task::spawn_blocking(move || {
            let (rgba, width, height) = png_to_rgba(&bytes)?;
            app_handle
                .clipboard()
                .write_image(&tauri::image::Image::new_owned(rgba, width, height))
                .map_err(|err| IpcError::new("clipboard-failed", err.to_string()))
        })
        .await
        .map_err(|err| IpcError::new("clipboard-failed", err.to_string()))??;
        Ok(Value::Null)
    })
}

/// Mermaid "Save image..." (#471): the user picks the path in a native dialog; null when cancelled.
pub fn clipboard_save_image(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let bytes = decode_png_bytes(&args, "clipboard.saveImage")?;
        let name = args
            .get(1)
            .and_then(Value::as_str)
            .filter(|n| !n.is_empty() && n.len() <= 128 && !n.contains(['/', '\\']))
            .unwrap_or("image.png")
            .to_string();
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
        let path = picked
            .into_path()
            .map_err(|_| IpcError::new("clipboard-failed", "The chosen location is not a file path"))?;
        tokio::fs::write(&path, bytes)
            .await
            .map_err(|err| IpcError::new("clipboard-failed", format!("The image could not be saved: {err}")))?;
        Ok(Value::String(path.to_string_lossy().into_owned()))
    })
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
