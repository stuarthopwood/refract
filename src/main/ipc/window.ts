// IPC handlers for `window.*` (spec 001 T100, contracts/ipc.md): `popupMenu` pops open one of the
// in-app menu bar's real submenus by id, and `toggleMaximize` backs the "double-click a draggable
// top-row area maximises or restores" rule (FR-057). Both are plain main-only window operations,
// never a renderer-side chrome change (constitution V).
import { ipcMain } from 'electron';
import type { BrowserWindow, Menu } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { AppMenuId, Result } from '../../shared/ipc';
import { popupAppMenu } from '../menu';
import { invalidArgument, notFound } from './util';

const APP_MENU_IDS: Record<AppMenuId, true> = { file: true, edit: true, view: true, window: true };

function isAppMenuId(value: unknown): value is AppMenuId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(APP_MENU_IDS, value);
}

export function registerWindow(appMenu: Menu, getWindow: () => BrowserWindow | undefined): void {
  ipcMain.handle(IPC_REQUESTS.WINDOW_POPUP_MENU, async (_event, menuId: unknown, x: unknown, y: unknown): Promise<Result<void>> => {
    if (!isAppMenuId(menuId)) {
      return invalidArgument(`${IPC_REQUESTS.WINDOW_POPUP_MENU} expects one of 'file' | 'edit' | 'view' | 'window'`);
    }
    if (typeof x !== 'number' || typeof y !== 'number') {
      return invalidArgument(`${IPC_REQUESTS.WINDOW_POPUP_MENU} expects numeric x/y`);
    }
    const window = getWindow();
    if (!window || window.isDestroyed()) return notFound('No window to show the menu on');
    const popped = popupAppMenu(appMenu, menuId, window, x, y);
    if (!popped) return notFound(`Menu '${menuId}' has no submenu`);
    return { ok: true, value: undefined };
  });

  ipcMain.handle(IPC_REQUESTS.WINDOW_TOGGLE_MAXIMIZE, async (): Promise<Result<void>> => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return notFound('No window to maximise');
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return { ok: true, value: undefined };
  });
}
