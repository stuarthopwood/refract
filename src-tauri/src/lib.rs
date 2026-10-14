// `tauri::Builder` assembly for the EXPERIMENTAL Tauri/Rust build of Refract (issue #780, spec
// 016). Module tree per plan.md's own Project Structure -- each of these owns its own slice of
// the Electron build's `src/main`, ported module-for-module; most are still empty-but-compiling
// placeholders (their own file's doc comment says which Electron source they will eventually
// port) until a later milestone-1 slice fills them in.
pub mod events;
pub mod fs;
pub mod git;
pub mod github;
pub mod ipc;
pub mod omp;
pub mod process;
pub mod session;
pub mod shell;
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
pub fn data_dir() -> PathBuf {
    dirs::data_dir()
        .expect("refract-tauri: no platform data directory available")
        .join("refract-tauri")
}

/// Security LOW finding: restricts same-window navigation to the app's own origin -- the
/// Electron build's equivalent is `denyForeignNavigation`. `Url::origin()` compares
/// scheme+host+port as one unit, so neither a lookalike host nor a stray port can pass. A
/// `pnpm dev` run navigates to the Vite dev server (`tauri.conf.json`'s own `devUrl`,
/// `http://localhost:5174`); a built binary (`tauri build`, with or without `--debug`) navigates
/// to Tauri's own custom protocol, served as `http://tauri.localhost` on this build's
/// Windows-only target (`use_https_scheme` is left at its default `false`).
///
/// Which origin is actually in play is gated on `tauri::is_dev()` (`!cfg!(feature =
/// "custom-protocol")` in tauri 2.12.3), NOT on `cfg!(debug_assertions)` and NOT on allowing both
/// origins unconditionally -- two bugs found live in succession, 2026-10-13/14:
///
/// - `debug_assertions`-gated (first attempt): a `tauri build --debug` binary is still a
///   debug-PROFILE build, so a `debug_assertions`-gated allow list denied that binary's own
///   `http://tauri.localhost` navigation and left the window on `about:blank` with no error.
///   `is_dev()` reflects how the binary was actually *launched* (dev server vs. any built
///   binary), not the compiled profile, so it correctly treats `tauri build --debug` the same as
///   a release build: not dev mode, so the `tauri.localhost` branch applies.
/// - Allow-both-unconditionally (second attempt): a release build has no reason to ever accept
///   `localhost:5174` as a trusted same-window origin -- any local process listening on that port
///   would become a navigable same-window origin in a packaged app, a UI-spoofing risk the
///   Electron build's own `isOwnOrigin` does not have (it only allows the dev-server origin when
///   `isDev && ELECTRON_RENDERER_URL` is set).
fn is_allowed_navigation_url(url: &Url) -> bool {
    let allowed = if tauri::is_dev() {
        "http://localhost:5174"
    } else {
        "http://tauri.localhost"
    };
    url.origin()
        == Url::parse(allowed)
            .expect("allowed navigation origin is a valid URL")
            .origin()
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
    Ok(state
        .dispatcher
        .dispatch(&channel, state.app_state.clone(), args)
        .await)
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
    std::fs::create_dir_all(&data_dir).unwrap_or_else(|err| {
        panic!("refract-tauri: failed to create data directory {data_dir:?}: {err}")
    });

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
    let bootstrap_theme =
        serde_json::to_value(settings.get().theme).expect("ThemeId is always JSON-serialisable");

    // Phase 3 (tasks.md T029): the one `session::SessionManager` every agent-backed handler
    // dispatches into, sharing this SAME `registry`/`settings`/`app_handle` the registry-only
    // handlers already use -- never a second store instance.
    let registry = std::sync::Arc::new(tokio::sync::Mutex::new(registry));
    let settings = std::sync::Arc::new(tokio::sync::Mutex::new(settings));
    let app_handle_slot: std::sync::Arc<std::sync::Mutex<Option<tauri::AppHandle>>> =
        std::sync::Arc::new(std::sync::Mutex::new(None));
    // Issue #793: `shell::notifications::on_session_status` (called from `emit_session_status`)
    // needs the registry too, for the Session's live display name -- the same `Arc` every
    // agent-backed handler already shares, never a second store instance.
    let events = events::EventSink::new(app_handle_slot.clone(), registry.clone());
    let session_manager = session::SessionManager::new(registry.clone(), settings.clone(), events);
    let session_manager_for_exit = session_manager.clone();
    // Issue #623: cloned before `data_dir` moves into `AppState` below -- the setup closure
    // applies the saved window state, and the final `ExitRequested` handler writes it back.
    let data_dir_for_setup = data_dir.clone();
    let data_dir_for_exit = data_dir.clone();

    let app_state = AppState {
        data_dir,
        registry,
        settings,
        app_handle: app_handle_slot,
        session_manager,
    };
    let mut dispatcher = Dispatcher::new();
    ipc::register_handlers(&mut dispatcher);

    let app = tauri::Builder::default()
        // Issue #793: registered first, ahead of every other plugin -- a second launch should
        // exit (after focusing the first window) as early as possible, doing no other startup
        // work. No JS capability needed (`capabilities/default.json`'s own doc comment): this
        // plugin has no JavaScript API at all.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            if window.is_minimized().unwrap_or(false) {
                let _ = window.unminimize();
            }
            let _ = window.show();
            let _ = window.set_focus();
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                // Security: Debug level also writes envelopes (now channel+outcome only, see
                // `ipc::Dispatcher::dispatch`) to a persistent log file. Release builds drop to
                // Info so routine traffic never reaches disk; dev builds keep Debug for local
                // troubleshooting.
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        // Issue #793: OS notification on needs-you/finished, click-to-focus
        // (`shell::notifications`).
        .plugin(tauri_plugin_notification::init())
        .manage(ManagedState {
            app_state,
            dispatcher,
        })
        .invoke_handler(tauri::generate_handler![refract_request])
        .setup(move |app| {
            // Phase 3's event emission (`events::emit`) needs a live `AppHandle`, which does not
            // exist until `setup` runs -- filled in here, before the window is built, so it is
            // never observed `None` by any handler invoked after the event loop starts.
            let managed = app.state::<ManagedState>();
            *managed
                .app_state
                .app_handle
                .lock()
                .expect("app_handle mutex poisoned") = Some(app.handle().clone());

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
            // parity in milestone 1; spike section 1 confirms no visible gap either, issue
            // #793). Initially hidden (issue #623, mirrors Electron's own `show: false` ->
            // `ready-to-show`): the saved window state is applied below before the first paint,
            // so there is no flash at the default size/position first.
            // `tauri.vite.config.ts` keeps Vite's default root (the repository root, not
            // `tauri/`) so this build's HTML entry can reference the sibling
            // `src/tauri-bridge/` tree by an ordinary root-relative script `src` -- the built
            // (and dev-served) path for that entry is therefore `tauri/index.html`, not
            // `index.html`, in both `frontendDist` (`out/tauri-web/tauri/index.html`) and the
            // dev server (`http://localhost:5174/tauri/index.html`, `devUrl`'s origin plus this
            // same relative path).
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("tauri/index.html".into()))
                    .title("Refract (Rust preview)")
                    .inner_size(1280.0, 800.0)
                    .decorations(true)
                    .visible(false)
                    .initialization_script(&init_script)
                    // Security LOW finding: matches the Electron build's `denyForeignNavigation`
                    // -- same-window navigation to a remote page would otherwise replace the app
                    // UI (remote origins can already not reach `refract_request`, and wry denies
                    // new windows with no `on_new_window` handler set, but a same-window
                    // navigation away is a separate hole neither of those closes).
                    .on_navigation(is_allowed_navigation_url)
                    .build()?;

            // Issue #623: reads and applies the saved position/size/maximised state (a
            // one-off, startup-only blocking wait, same justification as the registry/settings
            // opens above), then keeps it current for the rest of the run and manages the
            // tracker so the final `ExitRequested` handler below can reach it to flush it.
            let window_state_tracker = tauri::async_runtime::block_on(
                shell::window_state::apply_on_startup(&data_dir_for_setup, &window),
            );
            {
                let tracker = window_state_tracker.clone();
                let window_for_events = window.clone();
                window.on_window_event(move |event| {
                    tracker.on_window_event(&window_for_events, event)
                });
            }
            app.manage(window_state_tracker);

            // Issue #793: the one global notification click handler, registered before any
            // notification is ever shown (`shell::notifications::init`'s own doc comment).
            shell::notifications::init(app.handle());

            window.show()?;

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
    app.run(move |app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            api.prevent_exit();
            let session_manager = session_manager_for_exit.clone();
            let app_handle = app_handle.clone();
            let data_dir = data_dir_for_exit.clone();
            tauri::async_runtime::spawn(async move {
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(15),
                    session_manager.stop_all(),
                )
                .await;
                // Issue #623: the final, awaited window-state write -- a fire-and-forget write
                // racing the `std::process::exit` below could lose the last resize or move.
                if let (Some(tracker), Some(window)) = (
                    app_handle.try_state::<std::sync::Arc<shell::window_state::Tracker>>(),
                    app_handle.get_webview_window("main"),
                ) {
                    tracker.save(&data_dir, &window).await;
                }
                std::process::exit(0);
            });
        }
    });
}
