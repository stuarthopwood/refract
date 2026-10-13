// `tauri::Builder` assembly for the EXPERIMENTAL Tauri/Rust build of Refract (issue #780, spec
// 016). Module tree per plan.md's own Project Structure -- each of these owns its own slice of
// the Electron build's `src/main`, ported module-for-module; most are still empty-but-compiling
// placeholders (their own file's doc comment says which Electron source they will eventually
// port) until a later milestone-1 slice fills them in.
pub mod events;
pub mod git;
pub mod ipc;
pub mod omp;
pub mod process;
pub mod session;
pub mod store;

use std::path::PathBuf;

use serde_json::Value;
use tauri::{WebviewUrl, WebviewWindowBuilder};

use ipc::{AppState, Dispatcher};

/// `%APPDATA%\refract-tauri` (FR-014) -- deliberately never the Electron build's own
/// `%APPDATA%\pinion` (`src/main/index.ts`'s pinned `userData` path): the two builds must never
/// read or write the same `registry.json`/`settings.json`. Resolved directly via `dirs`, not
/// Tauri's own conventional `app_data_dir()` (which derives the folder name from `identifier`/
/// `productName` instead), so this path stays exactly `refract-tauri` regardless of whatever
/// bundle identifier `tauri.conf.json` ends up with.
pub fn data_dir() -> PathBuf {
    dirs::data_dir()
        .expect("refract-tauri: no platform data directory available")
        .join("refract-tauri")
}

/// State `.manage()`d once at startup: the one `Dispatcher` every `refract_request` call routes
/// through, plus the `AppState` every registered handler receives.
struct ManagedState {
    app_state: AppState,
    dispatcher: Dispatcher,
}

/// The one Tauri command (FR-006): dispatches `channel`/`args` through the shared `Dispatcher`
/// and always resolves with the `Result<T>` envelope itself (success and failure alike), exactly
/// like `src/preload/index.ts`'s own `request<T>` helper does over `ipcRenderer.invoke`.
#[tauri::command]
async fn refract_request(
    state: tauri::State<'_, ManagedState>,
    channel: String,
    args: Vec<Value>,
) -> Result<Value, ()> {
    Ok(state.dispatcher.dispatch(&channel, state.app_state.clone(), args).await)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let data_dir = data_dir();
    std::fs::create_dir_all(&data_dir)
        .unwrap_or_else(|err| panic!("refract-tauri: failed to create data directory {data_dir:?}: {err}"));

    // FR-010: read the persisted theme BEFORE the window is created, so the initialization
    // script below runs before any renderer script does.
    let bootstrap_theme = ipc::read_bootstrap_theme(&data_dir);

    let app_state = AppState { data_dir };
    let mut dispatcher = Dispatcher::new();
    ipc::register_handlers(&mut dispatcher);

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().level(log::LevelFilter::Debug).build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .manage(ManagedState { app_state, dispatcher })
        .invoke_handler(tauri::generate_handler![refract_request])
        .setup(move |app| {
            // FR-010/FR-011: `window.__REFRACT_THEME_BOOTSTRAP__` set via an initialization
            // script, so `src/tauri-bridge/index.ts`'s synchronous `themeBootstrap()` -- and so
            // `main.tsx`'s very first line, `initThemeStore(window.refract.themeBootstrap().theme)`
            // -- reads it before any renderer script paints, matching the Electron preload's own
            // synchronous `ipcRenderer.sendSync` contract.
            let init_script = format!(
                "window.__REFRACT_THEME_BOOTSTRAP__ = {};",
                serde_json::json!({ "theme": bootstrap_theme })
            );

            // One main window, native decorations (spec.md Assumptions: no custom caption
            // parity in milestone 1), same initial/minimum size as the Electron build's own
            // `BrowserWindow` (`src/main/index.ts`'s `width: 1280, height: 800`).
            // `tauri.vite.config.ts` keeps Vite's default root (the repository root, not
            // `tauri/`) so this build's HTML entry can reference the sibling
            // `src/tauri-bridge/` tree by an ordinary root-relative script `src` -- the built
            // (and dev-served) path for that entry is therefore `tauri/index.html`, not
            // `index.html`, in both `frontendDist` (`out/tauri-web/tauri/index.html`) and the
            // dev server (`http://localhost:5174/tauri/index.html`, `devUrl`'s origin plus this
            // same relative path).
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("tauri/index.html".into()))
                .title("Refract (Rust preview)")
                .inner_size(1280.0, 800.0)
                .min_inner_size(1280.0, 800.0)
                .decorations(true)
                .initialization_script(&init_script)
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
