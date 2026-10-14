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
// Quality-gate correction (code review, 2026-10-14): an earlier version of this file read
// `tauri::menu::SubmenuBuilder`'s own per-method docs ("Windows/Linux: Unsupported" on its
// `undo()`/`redo()`/`fullscreen()` convenience methods) and dropped all three. That is wrong for
// two of them: muda 0.20.0's own Windows `run_predefined` match DOES have arms for `Undo`/`Redo`
// (simulated Ctrl+Z/Ctrl+Y keystrokes, the same mechanism `Cut`/`Copy` use) -- restored below via
// `.undo().redo()`. `Fullscreen` is the one that really is a no-op there (no `Fullscreen` arm at
// all, falling through to nothing when clicked) -- fixed with a custom `MenuItem` below calling
// `window.set_fullscreen(!is_fullscreen)` in `on_menu_event` instead of the predefined item.
// Reset Zoom / Zoom In / Zoom Out ship in Electron's PRODUCTION build (`menu.ts`; only Reload,
// Force Reload and Toggle DevTools are gated on `isDev`) -- ported here as three more custom
// items driving `WebviewWindow::set_zoom` against a tracked `ZOOM_FACTOR` (no getter exists on
// this Tauri version), with `window.popupMenu`'s own x/y multiplied by that same factor before
// building the popup position, mirroring `window.ts`'s own `webContents.getZoomFactor()` multiply
// exactly. No accelerator label on any of the three (code-review correction, round 2): this menu
// is popup-only, never attached as the window/app menu, so WebView2 never registers these as
// live keyboard shortcuts -- showing "Ctrl+=" next to an item that only fires on a click would be
// misleading. Tracked as a follow-up (#825) rather than wiring real accelerator keys, which
// would need intercepting them before WebView2's own browser-side zoom handling. Reload/Force
// Reload/Toggle DevTools stay out: nothing else in this build wires a reload/devtools action.

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

/// Page zoom level the View menu's Reset/In/Out items track (`WebviewWindow` has no zoom getter
/// on this Tauri version), separate from `Position::Logical`'s own OS-DPI scaling -- this is the
/// CSS-pixel page zoom `window.ts` also tracks via `webContents.getZoomFactor()`.
static ZOOM_FACTOR: StdMutex<f64> = StdMutex::new(1.0);

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

/// Builds the four submenus and registers the one app-wide `on_menu_event` listener their custom
/// (non-predefined) items need. Registered on the `AppHandle`, not a specific window (low-sev
/// code-review finding): a window-keyed listener would be silently replaced by any other lane
/// that also registers one for the same window label, where the app-wide listener is additive.
/// `Cut`/`Copy`/`Paste`/`SelectAll`/`Minimize` are `PredefinedMenuItem`s and fire their native
/// OS/WebView2 action with no handler of ours.
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

/// `window.popupMenu(menuId, x, y)` (FR-057): pops one top-level item's real submenu at `x`/`y`
/// (window-content-relative logical pixels, matching `popup_menu_at`'s own documented coordinate
/// space), multiplied by the current page zoom factor -- the same adjustment Electron's own
/// handler makes with `webContents.getZoomFactor()` before calling `Menu.popup`, since neither
/// API auto-adjusts for in-page CSS zoom (distinct from OS DPI scaling, which `Position::Logical`
/// already handles on its own).
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

        let zoom = *ZOOM_FACTOR.lock().expect("zoom factor mutex poisoned");
        window
            .popup_menu_at(
                submenu,
                Position::Logical(LogicalPosition::new(x * zoom, y * zoom)),
            )
            .map_err(|err| IpcError::new("not-found", format!("Could not show the menu: {err}")))?;
        Ok(Value::Null)
    })
}
