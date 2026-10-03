// The app's File/Edit/View/Window application menu (spec 001 T100, FR-057). `Menu.setApplicationMenu`
// is what keeps every accelerator -- copy, paste, undo, redo, zoom, and in development reload/
// toggle developer tools -- working by keyboard even though the merged top row never shows a
// visible native menu bar: confirmed live, `docs/spike/FINDINGS.md` item 33 (a real OS-level Alt
// keypress against a `titleBarStyle: 'hidden'` window left `isMenuBarVisible()` false throughout,
// while an identical accelerator on the same kind of window still fired its handler). The
// renderer's `AppMenuBar` draws its own File/Edit/View/Window row (Alt reveals it, Esc or a click
// away hides it) and asks main to pop open the real submenu built here by id, so every item
// (including the dev-only ones) is the one true Electron `Menu`, never a second re-implementation.
import { Menu } from 'electron';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';
import type { AppMenuId } from '../shared/ipc';

const MENU_LABEL: Record<AppMenuId, string> = {
  file: 'File',
  edit: 'Edit',
  view: 'View',
  window: 'Window',
};

// Tags each top-level template item with its shared `AppMenuId` (`shared/ipc.ts`'s `APP_MENU_IDS`)
// as the item's own `id`, so `popupAppMenu` below looks a submenu up by that stable id via
// `Menu.getMenuItemById`, never by matching the (locale-able, display-only) `label` text.

export function buildAppMenu(isDev: boolean): Menu {
  const devOnlyViewItems: MenuItemConstructorOptions[] = isDev
    ? [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }]
    : [];

  return Menu.buildFromTemplate([
    {
      id: 'file',
      label: MENU_LABEL.file,
      submenu: [{ role: 'close' }],
    },
    {
      id: 'edit',
      label: MENU_LABEL.edit,
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      id: 'view',
      label: MENU_LABEL.view,
      submenu: [
        ...devOnlyViewItems,
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      id: 'window',
      label: MENU_LABEL.window,
      submenu: [
        { role: 'minimize' },
        {
          label: 'Maximize',
          click: (_menuItem, window) => {
            if (!window) return;
            if (window.isMaximized()) window.unmaximize();
            else window.maximize();
          },
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
  ]);
}

/** Pops open one top-level item's real submenu at `x`/`y` (window-content-relative, device/CSS
 * pixels per `BrowserWindow.setTitleBarOverlay`/`Menu.popup`'s own coordinate space -- the IPC
 * handler in `src/main/ipc/window.ts` already multiplies the renderer's raw CSS-pixel
 * `getBoundingClientRect()` by `webContents.getZoomFactor()` before calling this, so a zoomed
 * page still pops the menu under the clicked button instead of drifting). Returns `false` if
 * `menuId` somehow has no matching submenu (never expected, `buildAppMenu` always sets one for
 * every `AppMenuId`), letting the IPC handler report it instead of silently doing nothing. */
export function popupAppMenu(appMenu: Menu, menuId: AppMenuId, window: BrowserWindow, x: number, y: number): boolean {
  const item = appMenu.getMenuItemById(menuId);
  if (!item?.submenu) return false;
  item.submenu.popup({ window, x, y });
  return true;
}
