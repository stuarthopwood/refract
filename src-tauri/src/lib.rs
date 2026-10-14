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
pub mod updates;

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
/// Issue #795 (R12a, verification harness): under `#[cfg(debug_assertions)]` only (gate-fix,
/// security review MEDIUM: a packaged release build must never honour an env var that redirects
/// where it reads/writes session data), `REFRACT_DATA_DIR` overrides this with an absolute path
/// when set, so `scripts/verify-tauri.mjs` can point a dev instance at a scratch directory
/// instead of the real profile -- the same role Electron's own `--user-data-dir` CLI flag plays
/// (README.md "Where state lives"). Tauri has no such flag (the Rust CLI's `--config` only
/// overlays `tauri.conf.json`, not an arbitrary app-data path), and `dirs::data_dir()` calls
/// `SHGetKnownFolderPath` directly, which does not honour a redirected `%APPDATA%` env var on an
/// ordinary (non-redirected) Windows profile -- so this override is this build's own env var, not
/// a side effect of setting `APPDATA` on the child process. Unset in every normal run; a no-op
/// for `pnpm dev`/`pnpm build` run without the harness, and always a no-op in a release build
/// regardless of whether the variable happens to be set.
pub fn data_dir() -> PathBuf {
    #[cfg(debug_assertions)]
    {
        if let Some(path) = resolve_data_dir_override(std::env::var("REFRACT_DATA_DIR").ok()) {
            return path;
        }
    }
    dirs::data_dir()
        .expect("refract-tauri: no platform data directory available")
        .join("refract-tauri")
}

/// Pure override-resolution logic, factored out of `data_dir()` so it is `#[test]`-able without
/// touching the real process environment (gate-fix, tests review MEDIUM). Returns `None` (so the
/// caller falls back to the real data dir) for an unset/empty/whitespace-only value, or for a
/// relative path (gate-fix, security review LOW: a relative value used to be accepted silently
/// and resolved against the process's own current directory, which is never what the harness
/// intends -- it always passes an absolute scratch directory).
fn resolve_data_dir_override(raw: Option<String>) -> Option<PathBuf> {
    let raw = raw?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        eprintln!("refract-tauri: REFRACT_DATA_DIR must be an absolute path, ignoring relative value {trimmed:?}");
        return None;
    }
    Some(path)
}

/// Electron's own pinned `userData` dir (`src/main/index.ts`): `%APPDATA%\pinion`. One-time
/// data import's read-only source (`store::import`, #796 item 6, lane R13a); never written.
///
/// Debug builds only, same posture as `REFRACT_DATA_DIR` above: `REFRACT_IMPORT_SOURCE_DIR`
/// overrides this with an absolute path so a live check can point the import at a scratch copy
/// instead of Stuart's real `%APPDATA%\pinion`. Unset in every normal run; no-op in release.
///
/// Returns `None` (#796 follow-up safety fix) when a scratch `REFRACT_DATA_DIR` override is
/// active with no `REFRACT_IMPORT_SOURCE_DIR`: never silently copy Stuart's real registry.json.
fn electron_source_dir() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        if let Some(path) =
            resolve_data_dir_override(std::env::var("REFRACT_IMPORT_SOURCE_DIR").ok())
        {
            return Some(path);
        }
        if resolve_data_dir_override(std::env::var("REFRACT_DATA_DIR").ok()).is_some() {
            return None;
        }
    }
    Some(
        dirs::data_dir()
            .expect("refract-tauri: no platform data directory available")
            .join("pinion"),
    )
}

#[cfg(test)]
mod data_dir_tests {
    use super::resolve_data_dir_override;
    use std::path::PathBuf;

    #[test]
    fn absolute_path_is_used() {
        assert_eq!(
            resolve_data_dir_override(Some("C:/scratch/refract".to_string())),
            Some(PathBuf::from("C:/scratch/refract"))
        );
    }

    #[test]
    fn relative_path_is_rejected() {
        assert_eq!(
            resolve_data_dir_override(Some("scratch/refract".to_string())),
            None
        );
    }

    #[test]
    fn empty_or_whitespace_is_ignored() {
        assert_eq!(resolve_data_dir_override(Some(String::new())), None);
        assert_eq!(resolve_data_dir_override(Some("   ".to_string())), None);
    }

    #[test]
    fn unset_is_none() {
        assert_eq!(resolve_data_dir_override(None), None);
    }
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
    is_allowed_navigation_origin(url, tauri::is_dev())
}

/// Pure core of the check above, `is_dev` taken as a parameter (rather than read from
/// `tauri::is_dev()` directly) so both branches are unit-testable with no running Tauri app.
fn is_allowed_navigation_origin(url: &Url, is_dev: bool) -> bool {
    let allowed = if is_dev {
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
    // async store opens to completion here -- the one startup-only spot before the event loop
    // exists where a blocking wait for that is fine.
    //
    // `store::import::import_once` below writes the one-time Electron import (#796 item 6) when
    // `electron_source_dir()` resolves a real source; `None` skips it entirely (safety fix,
    // #796 follow-up, 2026-10-14; see `electron_source_dir`'s and `store::import`'s own docs).
    let (registry, settings, update_state, _import_lock) = tauri::async_runtime::block_on(async {
        let import_lock = match electron_source_dir() {
            Some(source_dir) => {
                let (outcome, lock) = store::import::import_once(&data_dir, &source_dir).await;
                store::import::log_outcome(&outcome);
                lock
            }
            None => {
                // `log::info!` is silently dropped before `Builder`'s logger plugin exists;
                // `eprintln!` like `resolve_data_dir_override` above.
                eprintln!("refract-tauri: data import: skipped (scratch REFRACT_DATA_DIR override active with no REFRACT_IMPORT_SOURCE_DIR override), no marker written");
                None
            }
        };

        // Lane R3 (issue #786, FR-005's fallback): reaps any orphaned `omp` root process before
        // this run spawns a new one -- must run before any Session's `SessionAgent` attaches
        // (no ordering dependency on the import above: it never touches `processes.json`).
        process::pid_records::init_and_reap(&data_dir).await;
        let registry = store::registry::RegistryStore::open(&data_dir)
            .await
            .unwrap_or_else(|err| panic!("refract-tauri: failed to open registry.json: {err}"));
        let settings = store::settings::SettingsStore::open(&data_dir)
            .await
            .unwrap_or_else(|err| panic!("refract-tauri: failed to open settings.json: {err}"));
        // Lane R11b (issue #794): `UpdateStateStore::open` never fails (falls back to
        // `UpdateState::default()` on any read/parse problem, same as `registry`/`settings`'s
        // own corrected-default-in-memory stance) -- no `unwrap_or_else`/`panic!` needed here.
        let update_state = updates::state::UpdateStateStore::open(&data_dir).await;
        (registry, settings, update_state, import_lock)
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
    let events_for_memory_monitor = events.clone();
    let session_manager = session::SessionManager::new(registry.clone(), settings.clone(), events);
    shell::memory::start_monitor(session_manager.clone(), events_for_memory_monitor);
    let session_manager_for_exit = session_manager.clone();
    // Lane R11b (issue #794): the startup resolve-installing-state-then-check runs inside the
    // `setup` closure below (after the window is shown, contracts/ipc.md "Startup behaviour");
    // the install-on-quit hook runs in the `ExitRequested` handler further down. Neither is
    // `AppState::session_manager`'s own agent-backed path, so a dedicated clone each, same
    // reasoning as `session_manager_for_exit`/`data_dir_for_setup` just above/below.
    let session_manager_for_updates_startup = session_manager.clone();
    let update_state = std::sync::Arc::new(tokio::sync::Mutex::new(update_state));
    let update_state_for_setup = update_state.clone();
    let update_state_for_exit = update_state.clone();
    // Issue #623: cloned before `data_dir` moves into `AppState` below -- the setup closure
    // applies the saved window state (`shell::window_state::Tracker` keeps its own copy for
    // the final write at quit, so only one clone is needed here).
    let data_dir_for_setup = data_dir.clone();
    // Lane R11b (issue #794): the install-on-quit hook needs `<data_dir>/updates` to re-verify
    // a `Downloaded` installer before scheduling it (`install_on_quit::verify_installer_before_
    // quit`), after `data_dir` itself has moved into `AppState` below.
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
        // Gate fix (issue #793): the plugin's own `init()` defaults to `open_js_links_on_click
        // (true)`, which injects ANOTHER `<a>`-click interceptor of its own -- disabled here so
        // `src/tauri-bridge/externalLinks.ts`'s own capture-phase handler is the single path a
        // link click ever takes (and the only one this lane's security baseline documents).
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
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
                    .title("Refract")
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
            // Lane R11b (issue #794): managed Tauri state (not an `AppState` field, see
            // `ipc::updates`'s own header comment) so `ipc::updates`/`ipc::readiness`'s handlers
            // can reach it through the live `AppHandle` `AppState::app_handle` already carries.
            app.manage(update_state_for_setup.clone());

            // Issue #793: the one global notification click handler, registered before any
            // notification is ever shown (`shell::notifications::init`'s own doc comment).
            shell::notifications::init(app.handle());

            window.show()?;

            // contracts/ipc.md "Startup behaviour" (FR-020, SC-010): kicked off after the
            // window is shown, never awaited before `window.show()` above -- the same
            // fire-and-forget stance `shell::memory`'s own sampler timer already takes rather
            // than blocking startup on it. Logic lives in `updates::run_startup_update_check`
            // (`AGENTS.md` "No god files").
            {
                let update_state = update_state_for_setup.clone();
                let session_manager = session_manager_for_updates_startup.clone();
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let current_version = app_handle.package_info().version.to_string();
                    let on_state = {
                        let session_manager = session_manager.clone();
                        move |state: &updates::state::UpdateState| {
                            let payload =
                                serde_json::to_value(ipc::updates::to_renderer_state(state))
                                    .expect("UpdateState is always JSON-serialisable");
                            session_manager.emit_updates_state_changed(&payload);
                        }
                    };
                    updates::run_startup_update_check(&update_state, &current_version, &on_state)
                        .await;
                });
            }
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
            let update_state = update_state_for_exit.clone();
            let updates_dir = data_dir_for_exit.join("updates");
            tauri::async_runtime::spawn(async move {
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(15),
                    session_manager.stop_all(),
                )
                .await;
                // Lane R11b (issue #794), FR-015/FR-016: runs after every live agent has
                // already been asked to stop above, so install-on-quit never interrupts a
                // running agent. Logic lives in `updates::run_install_on_quit_hook` (`AGENTS.md`
                // "No god files").
                updates::run_install_on_quit_hook(&update_state, &updates_dir).await;
                // Issue #623: the final, awaited window-state write. The maximised flag was
                // already captured fresh at `WindowEvent::CloseRequested` time (gate fix: the
                // window itself may already be destroyed by now for a user-initiated close/
                // Alt+F4, so `save()` needs no window handle at all); this call is what covers
                // a quit that never goes through `CloseRequested` (a direct `app.exit()`/signal).
                if let Some(tracker) =
                    app_handle.try_state::<std::sync::Arc<shell::window_state::Tracker>>()
                {
                    tracker.save().await;
                }
                std::process::exit(0);
            });
        }
    });
}

#[cfg(test)]
mod is_allowed_navigation_origin_tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).expect("test URL must parse")
    }

    #[test]
    fn dev_allows_the_exact_dev_server_origin() {
        assert!(is_allowed_navigation_origin(
            &url("http://localhost:5174/some/path"),
            true
        ));
    }

    #[test]
    fn dev_refuses_a_different_port() {
        assert!(!is_allowed_navigation_origin(
            &url("http://localhost:5175"),
            true
        ));
    }

    #[test]
    fn dev_refuses_a_different_scheme_on_the_same_host_and_port() {
        assert!(!is_allowed_navigation_origin(
            &url("https://localhost:5174"),
            true
        ));
    }

    #[test]
    fn dev_refuses_a_remote_host() {
        assert!(!is_allowed_navigation_origin(
            &url("http://evil.example.com:5174"),
            true
        ));
    }

    #[test]
    fn production_allows_the_exact_tauri_localhost_origin() {
        assert!(is_allowed_navigation_origin(
            &url("http://tauri.localhost/tauri/index.html"),
            false
        ));
    }

    #[test]
    fn production_refuses_the_dev_server_origin() {
        // The "allow-both-unconditionally" bug this doc comment names: a release build has no
        // reason to ever trust `localhost:5174` as a same-window origin.
        assert!(!is_allowed_navigation_origin(
            &url("http://localhost:5174"),
            false
        ));
    }

    #[test]
    fn production_refuses_a_different_host() {
        assert!(!is_allowed_navigation_origin(
            &url("http://evil.example.com"),
            false
        ));
    }

    #[test]
    fn file_scheme_is_refused_in_both_modes() {
        assert!(!is_allowed_navigation_origin(
            &url("file:///C:/secrets.txt"),
            true
        ));
        assert!(!is_allowed_navigation_origin(
            &url("file:///C:/secrets.txt"),
            false
        ));
    }

    #[test]
    fn javascript_scheme_is_refused_in_both_modes() {
        assert!(!is_allowed_navigation_origin(
            &url("javascript:alert(1)"),
            true
        ));
        assert!(!is_allowed_navigation_origin(
            &url("javascript:alert(1)"),
            false
        ));
    }

    #[test]
    fn data_scheme_is_refused_in_both_modes() {
        assert!(!is_allowed_navigation_origin(
            &url("data:text/html,hi"),
            true
        ));
        assert!(!is_allowed_navigation_origin(
            &url("data:text/html,hi"),
            false
        ));
    }
}
