// Quit guard: closing the window or restarting for an update while a Session removal runs asks first.
// The prompt is a native dialog because the renderer may already be closing.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

use crate::ipc::sessions_lifecycle::delete_in_flight;

/// Set once the user chose "Quit anyway", so the close that follows is not asked about again.
static QUIT_CONFIRMED: AtomicBool = AtomicBool::new(false);

/// True while a dialog is open, so a second close click or "Update now" does not stack another.
static PROMPTING: AtomicBool = AtomicBool::new(false);

/// Holds a window close back while a removal runs, and closes the window once the user confirms.
pub fn on_close_requested(window: &WebviewWindow, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if QUIT_CONFIRMED.load(Ordering::SeqCst) || !delete_in_flight::any_in_flight() {
        return;
    }
    api.prevent_close();
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        if confirm_quit(window.app_handle()).await {
            let _ = window.close();
        }
    });
}

/// True when the app may quit: nothing is being deleted, or the user chose to quit anyway.
pub async fn confirm_quit(app: &AppHandle) -> bool {
    if QUIT_CONFIRMED.load(Ordering::SeqCst) || !delete_in_flight::any_in_flight() {
        return true;
    }
    if PROMPTING.swap(true, Ordering::SeqCst) {
        return false;
    }
    let app = app.clone();
    let accepted = tokio::task::spawn_blocking(move || {
        app.dialog()
            .message("A Session is still being deleted. Quit anyway?")
            .title("Quit Refract?")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Quit anyway".into(),
                "Keep waiting".into(),
            ))
            .blocking_show()
    })
    .await
    .unwrap_or(false);
    PROMPTING.store(false, Ordering::SeqCst);
    if accepted {
        QUIT_CONFIRMED.store(true, Ordering::SeqCst);
    }
    accepted
}
