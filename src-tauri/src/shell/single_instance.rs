//! Single-instance handoff and its debug-only scratch bypass.

use tauri::{Builder, Manager, Runtime};

/// Registers the single-instance plugin first, so a second launch focuses the first window and exits.
pub fn register<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    if is_scratch_instance() {
        return builder;
    }
    builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        let _ = window.show();
        let _ = window.set_focus();
    }))
}

/// Debug-only: a scratch check must not hand off to the user's running Refract (the plugin keys on the bundle id).
/// The launcher also sets `WEBVIEW2_USER_DATA_FOLDER`; see `scripts/verify-tauri*`.
fn is_scratch_instance() -> bool {
    cfg!(debug_assertions)
        && crate::resolve_data_dir_override(std::env::var("REFRACT_DATA_DIR").ok()).is_some()
}
