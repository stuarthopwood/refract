// Page zoom for the shortcut keys and the View menu (#825), persisted to `zoom.json` in `data_dir()`.

use std::path::{Path, PathBuf};
use std::sync::{Mutex as StdMutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Manager, WebviewWindow};

use crate::ipc::{invalid_argument, AppState, Dispatcher, HandlerFuture};
use crate::store::atomic_json::{read_json_file, write_json_file};

const FILE_NAME: &str = "zoom.json";
const ZOOM_STEP: f64 = 1.1;
const ZOOM_MIN: f64 = 0.25;
const ZOOM_MAX: f64 = 3.0;

/// Page zoom the shell tracks, since this Tauri version has no zoom getter.
static ZOOM_FACTOR: StdMutex<f64> = StdMutex::new(1.0);
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

#[derive(Serialize, Deserialize)]
struct SavedZoom {
    factor: f64,
}

/// Registers `window.zoom` with the dispatcher.
pub fn register(d: &mut Dispatcher) {
    d.register("window.zoom", window_zoom);
}

/// The current page zoom, for scaling popup-menu coordinates.
pub fn current() -> f64 {
    *ZOOM_FACTOR.lock().expect("zoom factor mutex poisoned")
}

/// Re-applies the saved zoom at startup; a missing or hand-corrupted file leaves 100%.
pub async fn restore_on_startup(data_dir: &Path, window: &WebviewWindow) {
    let _ = DATA_DIR.set(data_dir.to_path_buf());
    let saved: Option<SavedZoom> = read_json_file(&data_dir.join(FILE_NAME), || None)
        .await
        .unwrap_or_else(|err| {
            log::warn!("refract-tauri: failed to read zoom.json: {err}");
            None
        });
    let Some(saved) = saved.filter(|s| s.factor.is_finite()) else {
        return;
    };
    let factor = saved.factor.clamp(ZOOM_MIN, ZOOM_MAX);
    *ZOOM_FACTOR.lock().expect("zoom factor mutex poisoned") = factor;
    let _ = window.set_zoom(factor);
}

/// Sets the zoom to `factor` (clamped), applies it to the main window and saves it.
pub fn apply(app: &tauri::AppHandle, factor: f64) {
    let clamped = factor.clamp(ZOOM_MIN, ZOOM_MAX);
    *ZOOM_FACTOR.lock().expect("zoom factor mutex poisoned") = clamped;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_zoom(clamped);
    }
    if let Some(dir) = DATA_DIR.get() {
        let file = dir.join(FILE_NAME);
        tauri::async_runtime::spawn(async move {
            if let Err(err) = write_json_file(&file, &SavedZoom { factor: clamped }).await {
                log::warn!("refract-tauri: failed to write zoom.json: {err}");
            }
        });
    }
}

/// One zoom step in (`true`) or out (`false`) from the current level.
pub fn step(app: &tauri::AppHandle, zoom_in: bool) {
    let current = current();
    apply(app, if zoom_in { current * ZOOM_STEP } else { current / ZOOM_STEP });
}

/// `window.zoom`: `'in'` | `'out'` | `'reset'`.
fn window_zoom(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let action = args.first().and_then(Value::as_str).unwrap_or_default();
        if !matches!(action, "in" | "out" | "reset") {
            return Err(invalid_argument(
                "window.zoom expects 'in' | 'out' | 'reset'",
            ));
        }
        let app = state
            .app_handle
            .lock()
            .expect("app_handle mutex poisoned")
            .clone();
        let Some(app) = app else {
            return Err(crate::ipc::not_found("No window to zoom"));
        };
        match action {
            "in" => step(&app, true),
            "out" => step(&app, false),
            _ => apply(&app, 1.0),
        }
        Ok(Value::Null)
    })
}
