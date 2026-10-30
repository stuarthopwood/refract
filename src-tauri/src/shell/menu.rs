// Popup-only menu for `window.popupMenu`; never the window's own menu bar, which would duplicate AppMenuBar.
// Ctrl+W and the zoom items are custom, so Ctrl+W reaches the renderer (#621); zoom labels have no accelerator (#825).

use std::sync::Mutex as StdMutex;

use serde_json::Value;
use tauri::menu::{MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{LogicalPosition, Manager, Position, Wry};
use tokio::sync::OnceCell;

use crate::ipc::{invalid_argument, not_found, AppState, Dispatcher, HandlerFuture, IpcError};

const MENU_IDS: [&str; 4] = ["file", "edit", "view", "window"];

const ZOOM_STEP: f64 = 1.1;
const ZOOM_MIN: f64 = 0.25;
const ZOOM_MAX: f64 = 3.0;

/// Page zoom the View menu tracks, since this Tauri version has no zoom getter.
static ZOOM_FACTOR: StdMutex<f64> = StdMutex::new(1.0);

/// Registers the app menu's custom and predefined items with the dispatcher.
pub fn register(d: &mut Dispatcher) {
    d.register("window.popupMenu", window_popup_menu);
}

struct AppMenus {
    file: Submenu<Wry>,
    edit: Submenu<Wry>,
    view: Submenu<Wry>,
    window: Submenu<Wry>,
}

fn submenu_for<'a>(menus: &'a AppMenus, id: &str) -> Option<&'a Submenu<Wry>> {
    match id {
        "file" => Some(&menus.file),
        "edit" => Some(&menus.edit),
        "view" => Some(&menus.view),
        "window" => Some(&menus.window),
        _ => None,
    }
}

fn apply_zoom(app: &tauri::AppHandle, new_factor: f64) {
    let clamped = new_factor.clamp(ZOOM_MIN, ZOOM_MAX);
    *ZOOM_FACTOR.lock().expect("zoom factor mutex poisoned") = clamped;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_zoom(clamped);
    }
}

static MENUS: OnceCell<AppMenus> = OnceCell::const_new();

/// Builds the four submenus and their one app-wide `on_menu_event` listener.
/// App-wide, so a per-window registration elsewhere cannot replace it.
fn build_menus(app: &tauri::AppHandle) -> tauri::Result<AppMenus> {
    let file_close = MenuItemBuilder::with_id("file-close", "Close")
        .accelerator("Alt+F4")
        .build(app)?;
    let file = SubmenuBuilder::with_id(app, "file", "File")
        .item(&file_close)
        .build()?;

    let edit = SubmenuBuilder::with_id(app, "edit", "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view_fullscreen =
        MenuItemBuilder::with_id("view-toggle-fullscreen", "Toggle Full Screen").build(app)?;
    let view_reset_zoom = MenuItemBuilder::with_id("view-reset-zoom", "Reset Zoom").build(app)?;
    let view_zoom_in = MenuItemBuilder::with_id("view-zoom-in", "Zoom In").build(app)?;
    let view_zoom_out = MenuItemBuilder::with_id("view-zoom-out", "Zoom Out").build(app)?;
    let view = SubmenuBuilder::with_id(app, "view", "View")
        .item(&view_reset_zoom)
        .item(&view_zoom_in)
        .item(&view_zoom_out)
        .separator()
        .item(&view_fullscreen)
        .build()?;

    let window_maximize = MenuItemBuilder::with_id("window-maximize", "Maximize").build(app)?;
    let window_close = MenuItemBuilder::with_id("window-close", "Close")
        .accelerator("Alt+F4")
        .build(app)?;
    let window = SubmenuBuilder::with_id(app, "window", "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&window_maximize)
        .separator()
        .item(&window_close)
        .build()?;

    app.on_menu_event(move |app, event| {
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        match event.id().0.as_str() {
            "file-close" | "window-close" => {
                let _ = window.close();
            }
            "window-maximize" => match window.is_maximized() {
                Ok(true) => {
                    let _ = window.unmaximize();
                }
                _ => {
                    let _ = window.maximize();
                }
            },
            "view-toggle-fullscreen" => {
                if let Ok(is_fullscreen) = window.is_fullscreen() {
                    let _ = window.set_fullscreen(!is_fullscreen);
                }
            }
            "view-reset-zoom" => apply_zoom(app, 1.0),
            "view-zoom-in" => {
                let current = *ZOOM_FACTOR.lock().expect("zoom factor mutex poisoned");
                apply_zoom(app, current * ZOOM_STEP);
            }
            "view-zoom-out" => {
                let current = *ZOOM_FACTOR.lock().expect("zoom factor mutex poisoned");
                apply_zoom(app, current / ZOOM_STEP);
            }
            _ => {}
        }
    });

    Ok(AppMenus {
        file,
        edit,
        view,
        window,
    })
}

/// `window.popupMenu`: pops one top-level submenu at `x`/`y`, scaled by the page zoom factor.
fn window_popup_menu(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let menu_id = match args.first().and_then(Value::as_str) {
            Some(id) if MENU_IDS.contains(&id) => id.to_string(),
            _ => {
                return Err(invalid_argument(
                    "window.popupMenu expects one of 'file' | 'edit' | 'view' | 'window'",
                ))
            }
        };
        let (x, y) = match (
            args.get(1).and_then(Value::as_f64),
            args.get(2).and_then(Value::as_f64),
        ) {
            (Some(x), Some(y)) if x.is_finite() && y.is_finite() => (x, y),
            _ => {
                return Err(invalid_argument(
                    "window.popupMenu expects finite numeric x/y",
                ))
            }
        };

        let app_handle = state
            .app_handle
            .lock()
            .expect("app_handle mutex poisoned")
            .clone();
        let Some(app_handle) = app_handle else {
            return Err(not_found("No window to show the menu on"));
        };
        let Some(window) = app_handle.get_webview_window("main") else {
            return Err(not_found("No window to show the menu on"));
        };

        // Built off the async worker: the Tauri builders block on the main thread.
        let app_handle_for_menus = app_handle.clone();
        let menus = MENUS
            .get_or_try_init(|| async move {
                tauri::async_runtime::spawn_blocking(move || build_menus(&app_handle_for_menus))
                    .await
                    .and_then(std::convert::identity)
            })
            .await
            .map_err(|err| {
                IpcError::new(
                    "not-found",
                    format!("Could not build the native menu: {err}"),
                )
            })?;
        let Some(submenu) = submenu_for(menus, &menu_id) else {
            return Err(not_found(format!("Menu '{menu_id}' has no submenu")));
        };

        // Fire-and-forget: the popup runs a modal loop, so awaiting it would hang the IPC call.
        let zoom = *ZOOM_FACTOR.lock().expect("zoom factor mutex poisoned");
        let position = Position::Logical(LogicalPosition::new(x * zoom, y * zoom));
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(err) = window.popup_menu_at(submenu, position) {
                log::error!("window.popupMenu: could not show the menu: {err}");
            }
        });
        Ok(Value::Null)
    })
}
