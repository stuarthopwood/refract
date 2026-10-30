// `tauri::Builder` assembly for the Tauri build of Refract.
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
pub mod usage;

use std::path::PathBuf;

use serde_json::Value;
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};

use ipc::{AppState, Dispatcher};

/// `%APPDATA%\refract-tauri`, not the Electron build's `%APPDATA%\pinion`, so the two never share
/// a `registry.json`. Debug builds only: `REFRACT_DATA_DIR` redirects it for the verification harness.
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

/// Pure override resolution, testable without the process environment. Relative paths yield `None`.
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

/// The Electron build's `%APPDATA%\pinion`, read-only, for the one-time import. `None` with a scratch
/// `REFRACT_DATA_DIR` so the real registry is never copied.
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

/// Restricts same-window navigation to the app's own origin. Gated on `tauri::is_dev()`, since a
/// `tauri build --debug` binary must still get the `tauri.localhost` origin.
fn is_allowed_navigation_url(url: &Url) -> bool {
    is_allowed_navigation_origin(url, tauri::is_dev())
}

/// Pure core of the navigation check, with `is_dev` as a parameter so both branches are testable.
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

/// State managed once at startup; holds the shared `Dispatcher` and `AppState`.
struct ManagedState {
    app_state: AppState,
    dispatcher: Dispatcher,
}

/// The one Tauri command. Always resolves with the `Result<T>` envelope, success or failure.
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
    // Set before any child spawns so no `git` or `omp` child resolves the cwd.
    // SAFETY: called once, before any other thread exists.
    unsafe {
        std::env::set_var("NoDefaultCurrentDirectoryInExePath", "1");
    }

    // Must run before any window exists.
    shell::app_identity::set_process_app_user_model_id();

    let data_dir = data_dir();
    std::fs::create_dir_all(&data_dir).unwrap_or_else(|err| {
        panic!("refract-tauri: failed to create data directory {data_dir:?}: {err}")
    });

    // Opened before the window; `block_on` is safe because the event loop does not exist yet.
    let (registry, settings, update_state, _import_lock) = tauri::async_runtime::block_on(async {
        let import_lock = match electron_source_dir() {
            Some(source_dir) => {
                let (outcome, lock) = store::import::import_once(&data_dir, &source_dir).await;
                store::import::log_outcome(&outcome);
                lock
            }
            None => {
                // `log::info!` is dropped before the logger plugin exists.
                eprintln!("refract-tauri: data import: skipped (scratch REFRACT_DATA_DIR override active with no REFRACT_IMPORT_SOURCE_DIR override), no marker written");
                None
            }
        };

        process::pid_records::init_and_reap(&data_dir).await;
        let registry = store::registry::RegistryStore::open(&data_dir)
            .await
            .unwrap_or_else(|err| panic!("refract-tauri: failed to open registry.json: {err}"));
        let settings = store::settings::SettingsStore::open(&data_dir)
            .await
            .unwrap_or_else(|err| panic!("refract-tauri: failed to open settings.json: {err}"));
        let update_state = updates::state::UpdateStateStore::open(&data_dir).await;
        (registry, settings, update_state, import_lock)
    });

    let bootstrap_typography = settings.get().typography;
    let bootstrap_theme =
        serde_json::to_value(settings.get().theme).expect("ThemeId is always JSON-serialisable");

    // Shared with the registry-only handlers; a second store would diverge.
    let registry = std::sync::Arc::new(tokio::sync::Mutex::new(registry));
    let settings = std::sync::Arc::new(tokio::sync::Mutex::new(settings));
    let app_handle_slot: std::sync::Arc<std::sync::Mutex<Option<tauri::AppHandle>>> =
        std::sync::Arc::new(std::sync::Mutex::new(None));
    let events = events::EventSink::new(app_handle_slot.clone(), registry.clone());
    let events_for_memory_monitor = events.clone();
    let session_manager = session::SessionManager::new(registry.clone(), settings.clone(), events);
    shell::memory::start_monitor(session_manager.clone(), events_for_memory_monitor);
    let session_manager_for_exit = session_manager.clone();
    let session_manager_for_updates_startup = session_manager.clone();
    let update_state = std::sync::Arc::new(tokio::sync::Mutex::new(update_state));
    let update_state_for_setup = update_state.clone();
    let update_state_for_exit = update_state.clone();
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

    let app = shell::single_instance::register(tauri::Builder::default())
        .plugin(
            tauri_plugin_log::Builder::new()
                // Release builds stay at Info so routine IPC traffic never reaches disk.
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // Disabled so `src/tauri-bridge/externalLinks.ts` is the only link-click interceptor.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .manage(ManagedState {
            app_state,
            dispatcher,
        })
        .invoke_handler(tauri::generate_handler![refract_request])
        .setup(move |app| {
            let managed = app.state::<ManagedState>();
            *managed
                .app_state
                .app_handle
                .lock()
                .expect("app_handle mutex poisoned") = Some(app.handle().clone());

            // Set before any renderer script runs, so the synchronous theme bootstrap can read it.
            let init_script = format!(
                "window.__REFRACT_THEME_BOOTSTRAP__ = {};",
                serde_json::json!({ "theme": bootstrap_theme, "typography": bootstrap_typography })
            );

            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("tauri/index.html".into()))
                    .title("Refract")
                    .inner_size(1280.0, 800.0)
                    .decorations(true)
                    .visible(false)
                    .initialization_script(&init_script)
                    // Blocks same-window navigation to remote pages, which would replace the app UI.
                    .on_navigation(is_allowed_navigation_url)
                    .build()?;
            #[cfg(windows)]
            match window.hwnd() {
                Ok(hwnd) => shell::app_identity::apply_to_window(hwnd),
                Err(err) => log::warn!("refract-tauri: #880 icon/AUMID skipped, no hwnd: {err}"),
            }

            // Managed so exit can flush the tracker.
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
            app.manage(update_state_for_setup.clone());

            shell::notifications::init(app.handle());
            shell::alarms::spawn(app.handle().clone(), managed.app_state.settings.clone());

            window.show()?;

            {
                let update_state = update_state_for_setup.clone();
                let session_manager = session_manager_for_updates_startup.clone();
                let app_handle = app.handle().clone();
                let data_dir = data_dir_for_setup.clone();
                tauri::async_runtime::spawn(async move {
                    let current_version = app_handle.package_info().version.to_string();
                    ipc::updates::run_update_lifecycle(
                        session_manager,
                        update_state,
                        data_dir,
                        current_version,
                    )
                    .await;
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application");
    // Bounded to 15 s by `prevent_exit`, so a stuck `omp` cannot hold the app open.
    app.run(move |app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            api.prevent_exit();
            if !updates::begin_quit() {
                return;
            }
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
                ipc::repositories_clone::shutdown_all().await;
                // Runs after agents stop, so install-on-quit never interrupts one.
                updates::run_install_on_quit_hook(&update_state, &updates_dir).await;
                // Covers quits that skip `CloseRequested`; the window may already be gone.
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
        // A release build must never trust the dev server origin.
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
