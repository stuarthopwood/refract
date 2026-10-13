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
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};

use ipc::{AppState, Dispatcher};

/// `%APPDATA%\refract-tauri` (FR-014) -- deliberately never the Electron build's own
/// `%APPDATA%\pinion` (`src/main/index.ts`'s pinned `userData` path): the two builds must never
/// read or write the same `registry.json`/`settings.json`. Resolved directly via `dirs`, not
/// Tauri's own conventional `app_data_dir()` (which derives the folder name from `identifier`/
/// `productName` instead), so this path stays exactly `refract-tauri` regardless of whatever
/// bundle identifier `tauri.conf.json` ends up with.
///
/// Issue #795 (R12a, verification harness): `REFRACT_DATA_DIR` overrides this with a literal
/// absolute path when set, so `scripts/verify-tauri.mjs` can point a dev instance at a scratch
/// directory instead of the real profile -- the same role Electron's own `--user-data-dir` CLI
/// flag plays (README.md "Where state lives"). Tauri has no such flag (the Rust CLI's `--config`
/// only overlays `tauri.conf.json`, not an arbitrary app-data path), and `dirs::data_dir()` calls
/// `SHGetKnownFolderPath` directly, which does not honour a redirected `%APPDATA%` env var on an
/// ordinary (non-redirected) Windows profile -- so this override is this build's own env var, not
/// a side effect of setting `APPDATA` on the child process. Unset in every normal run; this is a
/// no-op for the packaged app and for `pnpm dev:tauri` run without the harness.
pub fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("REFRACT_DATA_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    dirs::data_dir()
        .expect("refract-tauri: no platform data directory available")
        .join("refract-tauri")
}

/// Security LOW finding: restricts same-window navigation to the app's own origin -- the
/// Electron build's equivalent is `denyForeignNavigation`. `Url::origin()` compares
/// scheme+host+port as one unit, so neither a lookalike host nor a stray port can pass.
///
/// Checks BOTH legitimate origins unconditionally, rather than branching on
/// `cfg!(debug_assertions)` (found live, 2026-10-13, R12a's own verification harness): a
/// `cargo build`/`tauri build` invoked with `--debug` -- the live-run convention every Phase R
/// lane now uses to avoid the shared Vite port and the shared `CARGO_TARGET_DIR` exe race (no
/// `tauri dev`, no dev server) -- still has `debug_assertions` true, so the old `cfg!` branch
/// expected the Vite dev server's origin even though this binary serves `frontendDist` over the
/// custom protocol exactly like a release build. That mismatch made the very first navigation
/// (from `about:blank` to the app's own real content) look "foreign" and silently denied it,
/// leaving the window permanently blank with no visible error. Allowing both origins always is
/// no weaker a guarantee: neither is attacker-controlled, and only one is ever actually reachable
/// in a given run (`devUrl` is loaded only when a dev server is actually serving it).
fn is_allowed_navigation_url(url: &Url) -> bool {
    let origin = url.origin();
    [
        Url::parse("http://localhost:5174").expect("dev-server navigation origin is a valid URL"),
        Url::parse("http://tauri.localhost").expect("custom-protocol navigation origin is a valid URL"),
    ]
    .iter()
    .any(|allowed| allowed.origin() == origin)
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
    // FR-001 / security LOW finding: set for the WHOLE process, as the very first thing `run()`
    // does -- mirrors the Electron build's own unconditional top-of-file env var line
    // (`src/main/index.ts`), so even a `git` child spawned before the first `omp` spawn (e.g.
    // `readiness.check`, `repositories.add`) is covered. `process::executables::
    // ensure_no_default_cwd_in_exe_path`'s own lazy, pre-first-`omp`-spawn call is now a
    // redundant no-op (the env var is already set by the time it runs) -- kept as-is rather
    // than removed, since its one caller lives in `omp::process` (a different owner's file).
    //
    // Safety: called once, synchronously, before any other code in this process (no window, no
    // handler, no spawned child) has started, so nothing else reads or writes this specific
    // variable concurrently.
    unsafe {
        std::env::set_var("NoDefaultCurrentDirectoryInExePath", "1");
    }

    let data_dir = data_dir();
    std::fs::create_dir_all(&data_dir)
        .unwrap_or_else(|err| panic!("refract-tauri: failed to create data directory {data_dir:?}: {err}"));

    // FR-010: opened BEFORE the window is created, so the theme bootstrap initialization script
    // below runs before any renderer script does. `tauri::async_runtime::block_on` runs the
    // async store opens to completion here -- `run()` itself is a plain `fn`, and this is the
    // one startup-only spot before the event loop exists where a blocking wait for that is fine
    // (`store::registry`/`store::settings`'s own doc comments: a failed open is an unexpected
    // I/O error, not a normal "missing file" case, which both modules already handle as a
    // corrected default in memory).
    let (registry, settings) = tauri::async_runtime::block_on(async {
        let registry = store::registry::RegistryStore::open(&data_dir)
            .await
            .unwrap_or_else(|err| panic!("refract-tauri: failed to open registry.json: {err}"));
        let settings = store::settings::SettingsStore::open(&data_dir)
            .await
            .unwrap_or_else(|err| panic!("refract-tauri: failed to open settings.json: {err}"));
        (registry, settings)
    });

    // FR-010/FR-011: the theme as `SettingsStore::open`'s own FR-013 lazy-correction already
    // resolved it (missing/invalid key falls back to `dark`), not a second, separate read.
    let bootstrap_theme = serde_json::to_value(settings.get().theme).expect("ThemeId is always JSON-serialisable");

    // Phase 3 (tasks.md T029): the one `session::SessionManager` every agent-backed handler
    // dispatches into, sharing this SAME `registry`/`settings`/`app_handle` the registry-only
    // handlers already use -- never a second store instance.
    let registry = std::sync::Arc::new(tokio::sync::Mutex::new(registry));
    let settings = std::sync::Arc::new(tokio::sync::Mutex::new(settings));
    let app_handle_slot: std::sync::Arc<std::sync::Mutex<Option<tauri::AppHandle>>> = std::sync::Arc::new(std::sync::Mutex::new(None));
    let events = events::EventSink::new(app_handle_slot.clone());
    let session_manager = session::SessionManager::new(registry.clone(), settings.clone(), events);
    let session_manager_for_exit = session_manager.clone();

    let app_state = AppState { data_dir, registry, settings, app_handle: app_handle_slot, session_manager };
    let mut dispatcher = Dispatcher::new();
    ipc::register_handlers(&mut dispatcher);

    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                // Security: Debug level also writes envelopes (now channel+outcome only, see
                // `ipc::Dispatcher::dispatch`) to a persistent log file. Release builds drop to
                // Info so routine traffic never reaches disk; dev builds keep Debug for local
                // troubleshooting.
                .level(if cfg!(debug_assertions) { log::LevelFilter::Debug } else { log::LevelFilter::Info })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .manage(ManagedState { app_state, dispatcher })
        .invoke_handler(tauri::generate_handler![refract_request])
        .setup(move |app| {
            // Phase 3's event emission (`events::emit`) needs a live `AppHandle`, which does not
            // exist until `setup` runs -- filled in here, before the window is built, so it is
            // never observed `None` by any handler invoked after the event loop starts.
            let managed = app.state::<ManagedState>();
            *managed.app_state.app_handle.lock().expect("app_handle mutex poisoned") = Some(app.handle().clone());

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
            // parity in milestone 1), same initial size as the Electron build's own
            // `BrowserWindow` (`src/main/index.ts`'s `width: 1280, height: 800`). Like Electron,
            // no minimum size, so the window still fits and reflows at 150-200% display scaling.
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
                .decorations(true)
                .initialization_script(&init_script)
                // Security LOW finding: matches the Electron build's `denyForeignNavigation` --
                // same-window navigation to a remote page would otherwise replace the app UI
                // (remote origins can already not reach `refract_request`, and wry denies new
                // windows with no `on_new_window` handler set, but a same-window navigation
                // away is a separate hole neither of those closes).
                .on_navigation(is_allowed_navigation_url)
                .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    // Port of `src/main/index.ts`'s own `before-quit` stop-all (tasks.md T029): every live
    // `omp` process is asked to exit gracefully (and force-killed past its own grace period,
    // `OmpProcess::stop`) before the app itself actually quits. `prevent_exit` defers Tauri's own
    // shutdown until that finishes or a 15 s bound elapses, whichever comes first -- a stuck
    // child must never hold the whole app open forever (the kill-on-close Job Object, already
    // joined before `run()` was ever called, is the final belt-and-braces guarantee regardless).
    app.run(move |_app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            api.prevent_exit();
            let session_manager = session_manager_for_exit.clone();
            tauri::async_runtime::spawn(async move {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(15), session_manager.stop_all()).await;
                std::process::exit(0);
            });
        }
    });
}
