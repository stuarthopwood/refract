// IPC handler for `window.*` (spec 001 T100, contracts/ipc.md): `popupMenu` pops open one of the
// in-app menu bar's real submenus by id. A plain main-only window operation, never a
// renderer-side chrome change (constitution V). (There is no `toggleMaximize` here: verified
// live, FINDINGS-equivalent evidence in tasks.md T100 -- double-clicking a `.drag-region`
// (HTCAPTION) area already maximises/restores the window entirely at the OS level before the
// double-click ever reaches the page's own JS, so a renderer-driven toggle would be unreachable,
// dead code.)
import { ipcMain } from 'electron';
import type { BrowserWindow, Menu } from 'electron';
import { APP_MENU_IDS, IPC_REQUESTS } from '../../shared/ipc';
import type { AppMenuId, Result } from '../../shared/ipc';
import { popupAppMenu } from '../menu';
import { invalidArgument, notFound } from './util';

function isAppMenuId(value: unknown): value is AppMenuId {
  return typeof value === 'string' && (APP_MENU_IDS as readonly string[]).includes(value);
}

export function registerWindow(appMenu: Menu, getWindow: () => BrowserWindow | undefined): void {
  ipcMain.handle(IPC_REQUESTS.WINDOW_POPUP_MENU, async (_event, menuId: unknown, x: unknown, y: unknown): Promise<Result<void>> => {
    if (!isAppMenuId(menuId)) {
      return invalidArgument(`${IPC_REQUESTS.WINDOW_POPUP_MENU} expects one of 'file' | 'edit' | 'view' | 'window'`);
    }
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      return invalidArgument(`${IPC_REQUESTS.WINDOW_POPUP_MENU} expects finite numeric x/y`);
    }
    const window = getWindow();
    if (!window || window.isDestroyed()) return notFound('No window to show the menu on');
    // `getBoundingClientRect()` gives the renderer's raw CSS pixels; `Menu.popup` wants the
    // window's own device pixels, which differ once the page is zoomed (the View menu now has
    // Zoom In/Out, so this is reachable, not just a hypothetical).
    const zoom = window.webContents.getZoomFactor();
    const popped = popupAppMenu(appMenu, menuId, window, Math.round(x * zoom), Math.round(y * zoom));
    if (!popped) return notFound(`Menu '${menuId}' has no submenu`);
    return { ok: true, value: undefined };
  });
}
