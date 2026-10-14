// Native menu (lane R8, issue #791): `window.popupMenu`, port of `src/main/ipc/window.ts` +
// `src/main/menu.ts`. Builds four detached `Submenu`s (File/Edit/View/Window) once, lazily, on
// first use -- never attached as the window's own menu bar (`WebviewWindow::set_menu`), since
// this build's window uses native OS decorations (`lib.rs`'s own "no custom caption parity in
// milestone 1" comment): attaching would show a second, OS-drawn menu row duplicating the
// renderer's own Alt-revealed `AppMenuBar.tsx` row. Popped up on demand via `popup_menu_at`,
// matching Electron's own `popupAppMenu` (a real native menu, never a second hand-rolled
// implementation) -- the one deliberate difference: Electron overrides `Close`'s accelerator to
// Alt+F4 so Ctrl+W reaches the renderer's own close-chat-pane handler instead of closing the
// window (#621); the custom `MenuItem`s below do the same.
//
// Not ported: `Undo`/`Redo` (Electron's Edit submenu -- `PredefinedMenuItem::undo`/`redo` are
// documented unsupported on Windows/Linux, tauri 2.12.3 docs.rs) and Reload/Force Reload/Toggle
// DevTools/Zoom (Electron's dev-only View items -- this build wires no reload/devtools/zoom
// action anywhere else, so there is nothing for those items to do yet). A native edit shortcut
// (Ctrl+C/V/X/A) already works directly against the focused WebView2 control without any menu.

use serde_json::Value;
use tauri::menu::{MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{LogicalPosition, Manager, Position, Wry};
use tokio::sync::OnceCell;

use crate::ipc::{invalid_argument, not_found, AppState, Dispatcher, HandlerFuture, IpcError};

const MENU_IDS: [&str; 4] = ["file", "edit", "view", "window"];

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

static MENUS: OnceCell<AppMenus> = OnceCell::const_new();

/// Builds the four submenus and registers the one `on_menu_event` listener their custom
/// (non-predefined) items need -- `Cut`/`Copy`/`Paste`/`SelectAll`/`Minimize`/`Fullscreen` are
/// `PredefinedMenuItem`s and fire their native OS/WebView2 action with no handler of ours.
fn build_menus(app: &tauri::AppHandle) -> tauri::Result<AppMenus> {
    let file_close = MenuItemBuilder::with_id("file-close", "Close")
        .accelerator("Alt+F4")
        .build(app)?;
    let file = SubmenuBuilder::with_id(app, "file", "File")
        .item(&file_close)
        .build()?;

    let edit = SubmenuBuilder::with_id(app, "edit", "Edit")
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view = SubmenuBuilder::with_id(app, "view", "View")
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
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

    if let Some(window_handle) = app.get_webview_window("main") {
        window_handle.on_menu_event(move |window, event| match event.id().0.as_str() {
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
            _ => {}
        });
    }

    Ok(AppMenus {
        file,
        edit,
        view,
        window,
    })
}

/// `window.popupMenu(menuId, x, y)` (FR-057): pops one top-level item's real submenu at `x`/`y`
/// (window-content-relative logical pixels, matching `popup_menu_at`'s own documented coordinate
/// space). Unlike Electron's handler, no zoom-factor multiply: this build's webview has no page
/// zoom control wired anywhere else, so the renderer's raw `getBoundingClientRect()` values are
/// used as-is.
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

        let menus = MENUS
            .get_or_try_init(|| async { build_menus(&app_handle) })
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

        window
            .popup_menu_at(submenu, Position::Logical(LogicalPosition::new(x, y)))
            .map_err(|err| IpcError::new("not-found", format!("Could not show the menu: {err}")))?;
        Ok(Value::Null)
    })
}
