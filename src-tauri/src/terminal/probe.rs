// Debug-only gate probe (research R-1, T012/T013): proves a Tauri `Channel` handle passed as an argument of
// `refract_request` can carry raw binary frames to the renderer without a new command or capability.
// Deleted after the gate passes (T014).

use serde_json::{json, Value};
use tauri::ipc::{InvokeResponseBody, JavaScriptChannelId};
use tauri::Manager;

use crate::ipc::{invalid_argument, AppState, Dispatcher, HandlerFuture, IpcError};

/// Below tauri's direct-execute threshold, so it travels in the script; the large one takes the fetch path.
pub const SMALL_FRAME_BYTES: usize = 8;
pub const LARGE_FRAME_BYTES: usize = 4096;

pub fn register(d: &mut Dispatcher) {
    d.register("terminal.probe", terminal_probe);
}

/// Deterministic content the verifier can recompute: byte `i` is `i % 251`.
pub fn pattern(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

/// Reads the `__CHANNEL__:<id>` string out of argument 0.
pub fn parse_channel_arg(args: &[Value]) -> Result<JavaScriptChannelId, IpcError> {
    let raw = args
        .first()
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_argument("channel must be a string"))?;
    raw.parse::<JavaScriptChannelId>()
        .map_err(|_| invalid_argument("channel is not a Tauri channel handle"))
}

fn terminal_probe(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = parse_channel_arg(&args)?;
        let webview = state
            .app_handle
            .lock()
            .expect("app_handle mutex poisoned")
            .clone()
            .and_then(|app| app.get_webview_window("main"))
            .ok_or_else(|| IpcError::new("terminal-failed", "The main window is not ready"))?;
        let channel = id.channel_on::<_, InvokeResponseBody>(webview.as_ref().clone());
        for len in [SMALL_FRAME_BYTES, LARGE_FRAME_BYTES] {
            channel
                .send(InvokeResponseBody::Raw(pattern(len)))
                .map_err(|_| IpcError::new("terminal-failed", "The probe frame was not sent"))?;
        }
        Ok(json!({ "sent": [SMALL_FRAME_BYTES, LARGE_FRAME_BYTES] }))
    })
}

#[cfg(test)]
#[path = "probe.test.rs"]
mod tests;
