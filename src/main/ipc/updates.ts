// IPC handlers for `updates.*` and `app.getVersion` (contracts/ipc.md "Updates"). Broadcasts
// `updates:state-changed` on every persisted transition via `UpdateStateStore.onChange`, the
// same pattern `src/main/ipc/broadcast.ts`'s `broadcastSettingsChanged` already establishes for
// `settings:changed` -- except driven by the store itself, since a download's own progress
// (`'downloading'` then `'downloaded'`/`'failed'`) is pushed mid-call, not only once at the end.

import { app, ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { IPC_EVENTS, IPC_REQUESTS } from '../../shared/ipc';
import type { Result, UpdateState } from '../../shared/ipc';
import type { UpdateStateStore } from '../store/updateState';
import { checkForUpdates } from '../update/UpdateChecker';
import { downloadUpdate, UpdateError } from '../update/UpdateInstaller';

export function registerUpdates(store: UpdateStateStore, getWindow: () => BrowserWindow | undefined): void {
  store.onChange((state) => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    try {
      window.webContents.send(IPC_EVENTS.UPDATES_STATE_CHANGED, state);
    } catch (err) {
      console.error('updates: failed to broadcast updates:state-changed', err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.UPDATES_CHECK, async (): Promise<Result<UpdateState>> => ({ ok: true, value: await checkForUpdates(store) }));

  ipcMain.handle(IPC_REQUESTS.UPDATES_GET_STATE, async (): Promise<Result<UpdateState>> => ({ ok: true, value: store.get() }));

  ipcMain.handle(IPC_REQUESTS.UPDATES_INSTALL, async (): Promise<Result<void>> => {
    try {
      await downloadUpdate(store);
      return { ok: true, value: undefined };
    } catch (err) {
      if (err instanceof UpdateError) return { ok: false, error: { code: err.code, message: err.message } };
      return { ok: false, error: { code: 'checksum-mismatch', message: err instanceof Error ? err.message : String(err) } };
    }
  });

  ipcMain.handle(IPC_REQUESTS.APP_GET_VERSION, async (): Promise<Result<string>> => ({ ok: true, value: app.getVersion() }));
}

/** FR-020, SC-010, contracts/ipc.md "Startup behaviour": kicked off after the window is shown,
 * never awaited before `BrowserWindow.show()` -- the same fire-and-forget pattern
 * `startMemoryMonitor` already uses on its own timer rather than blocking `createWindow()`. */
export function startAutomaticUpdateCheck(store: UpdateStateStore): void {
  void checkForUpdates(store).catch((err) => {
    console.error('updates: automatic startup check failed', err);
  });
}
