// Fallback for when the sandboxed renderer's clipboard write is refused; the main process needs no permission.

use serde_json::Value;
use tauri_plugin_clipboard_manager::ClipboardExt;

use super::{invalid_argument, AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("clipboard.writeText", clipboard_write_text);
    d.register("clipboard.readText", clipboard_read_text);
    d.register("clipboard.writeImage", clipboard_write_image);
}

/// Larger images are refused for both copy and save; the renderer reports the failure (#471, #1454).
pub(super) const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS: u64 = 16_000_000;
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

pub(super) fn decode_png_bytes(args: &[Value], method: &str) -> Result<Vec<u8>, IpcError> {
    use base64::Engine;
    let Some(encoded) = args.first().and_then(Value::as_str) else {
        return Err(invalid_argument(format!("{method} expects a base64 PNG")));
    };
    if encoded.len() > MAX_IMAGE_BYTES * 4 / 3 + 4 {
        return Err(IpcError::new(
            "clipboard-too-large",
            "The image is too large to copy or save (limit 8 MiB)",
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| invalid_argument(format!("{method} expects a base64 PNG")))?;
    // Signature, then a first chunk that is a 13-byte IHDR.
    let ihdr_ok = bytes
        .get(8..16)
        .is_some_and(|c| c == [0, 0, 0, 13, b'I', b'H', b'D', b'R']);
    if !bytes.starts_with(&PNG_SIGNATURE) || !ihdr_ok {
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
        return Err(IpcError::new(
            "clipboard-too-large",
            "The image has too many pixels to copy or save",
        ));
    }
    let mut buf = vec![0; reader.output_buffer_size().ok_or_else(bad)?];
    let frame = reader.next_frame(&mut buf).map_err(|_| bad())?;
    buf.truncate(frame.buffer_size());
    let rgba = match (frame.color_type, frame.bit_depth) {
        (png::ColorType::Rgba, png::BitDepth::Eight) => buf,
        (png::ColorType::Rgb, png::BitDepth::Eight) => buf
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
        let app_handle = state
            .app_handle
            .lock()
            .expect("app_handle mutex poisoned")
            .clone();
        let Some(app_handle) = app_handle else {
            return Err(IpcError::new("clipboard-failed", "No window yet"));
        };
        tokio::task::spawn_blocking(move || {
            let bytes = decode_png_bytes(&args, "clipboard.writeImage")?;
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
