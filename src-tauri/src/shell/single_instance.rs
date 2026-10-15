//! Single-instance handoff (issue #793) and its debug-only bypass for scratch live checks.

use tauri::{Builder, Manager, Runtime};

/// Registers `tauri-plugin-single-instance`: a second launch focuses the first window and
/// exits. Call it first, ahead of every other plugin, so a second launch does no other startup
/// work. No JS capability is needed (`capabilities/default.json`'s own doc comment): the plugin
/// has no JavaScript API at all.
///
/// Skipped for a scratch instance (see [`is_scratch_instance`]).
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

/// Debug builds only, same posture as `REFRACT_DATA_DIR` in `lib.rs`: a scratch live check runs
/// beside the user's own running Refract, and the plugin (keyed on the bundle identifier, not
/// the data dir) would hand the scratch launch off to that window and exit. Always `false` in a
/// release build. The override isolates Refract's own state only: the launcher must also set
/// `WEBVIEW2_USER_DATA_FOLDER` (and a scratch `OMP_PROFILE`), as `scripts/verify-tauri*` do,
/// and the plugin log file stays shared with the user's instance.
fn is_scratch_instance() -> bool {
    cfg!(debug_assertions)
        && crate::resolve_data_dir_override(std::env::var("REFRACT_DATA_DIR").ok()).is_some()
}
