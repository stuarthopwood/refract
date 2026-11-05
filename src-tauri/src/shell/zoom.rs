// Page zoom for the shortcut keys and the View menu (#825), persisted to `zoom.json` in `data_dir()`.

use std::path::{Path, PathBuf};
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Manager, WebviewWindow};
use tokio::sync::watch;

use crate::ipc::{invalid_argument, AppState, Dispatcher, HandlerFuture};
use crate::store::atomic_json::{read_json_file, write_json_file};

const FILE_NAME: &str = "zoom.json";
const ZOOM_STEP: f64 = 1.1;
const ZOOM_MIN: f64 = 0.25;
const ZOOM_MAX: f64 = 3.0;
const WRITE_DEBOUNCE: Duration = Duration::from_millis(300);

/// Page zoom the shell tracks, since this Tauri version has no zoom getter.
static ZOOM_FACTOR: StdMutex<f64> = StdMutex::new(1.0);
static WRITER: OnceLock<watch::Sender<f64>> = OnceLock::new();

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
    let _ = WRITER.set(spawn_writer(data_dir.join(FILE_NAME), 1.0));
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
    update(app, |_| factor);
}

/// One zoom step in (`true`) or out (`false`) from the current level.
pub fn step(app: &tauri::AppHandle, zoom_in: bool) {
    update(app, |current| {
        if zoom_in {
            current * ZOOM_STEP
        } else {
            current / ZOOM_STEP
        }
    });
}

/// Read-modify-write under one lock so concurrent steps compose instead of overwriting each other.
fn update(app: &tauri::AppHandle, next: impl FnOnce(f64) -> f64) {
    let clamped = {
        let mut factor = ZOOM_FACTOR.lock().expect("zoom factor mutex poisoned");
        *factor = next(*factor).clamp(ZOOM_MIN, ZOOM_MAX);
        *factor
    };
    // Outside the lock: set_zoom can wait on the main thread, which itself reads `current()`.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_zoom(clamped);
    }
    if let Some(writer) = WRITER.get() {
        writer.send_replace(clamped);
    }
}

/// One writer task per process: bursts of steps collapse into a single write of the latest factor,
/// and writes can no longer land out of order and persist a stale value.
fn spawn_writer(file: PathBuf, initial: f64) -> watch::Sender<f64> {
    let (tx, mut rx) = watch::channel(initial);
    tauri::async_runtime::spawn(async move {
        while rx.changed().await.is_ok() {
            tokio::time::sleep(WRITE_DEBOUNCE).await;
            let factor = *rx.borrow_and_update();
            if let Err(err) = write_json_file(&file, &SavedZoom { factor }).await {
                log::warn!("refract-tauri: failed to write zoom.json: {err}");
            }
        }
    });
    tx
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
