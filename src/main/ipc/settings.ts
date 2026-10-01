// IPC handlers for `settings.*` (contracts/ipc.md "Settings"). `setApprovalMode` persists the
// mode, then fans `pendingMode` out to every live Session via
// `SessionManager.applyPendingModeChange` (T031); each restarts at its own next settle
// (`SessionAgent.restart`, T032). Also broadcasts `settings:changed` so the renderer's store
// stays in sync even when a caller reaches `window.refract.settings.setApprovalMode` directly
// instead of through the store's own action (that action already self-updates from the IPC
// call's return value, but the broadcast is the only sync path for every other caller).

import { BrowserWindow, ipcMain } from 'electron';
import { IPC_EVENTS, IPC_REQUESTS } from '../../shared/ipc';
import type { Result } from '../../shared/ipc';
import type { ApprovalMode, Settings } from '../../shared/model';
import type { SessionManager } from '../SessionManager';

const APPROVAL_MODES: Record<ApprovalMode, true> = { ask: true, 'edit-freely': true, auto: true };

export function registerSettings(manager: SessionManager, getWindow: () => BrowserWindow | undefined): void {
  ipcMain.handle(IPC_REQUESTS.SETTINGS_GET, async (): Promise<Result<Settings>> => ({ ok: true, value: manager.settings.get() }));

  ipcMain.handle(IPC_REQUESTS.SETTINGS_SET_APPROVAL_MODE, async (_event, mode: unknown): Promise<Result<Settings>> => {
    if (typeof mode !== 'string' || !Object.prototype.hasOwnProperty.call(APPROVAL_MODES, mode)) {
      return {
        ok: false,
        error: {
          code: 'invalid-argument',
          message: `${IPC_REQUESTS.SETTINGS_SET_APPROVAL_MODE} expects one of 'ask' | 'edit-freely' | 'auto'`,
        },
      };
    }
    const value = await manager.settings.setApprovalMode(mode as ApprovalMode);
    manager.applyPendingModeChange(value.approvalMode);
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      try {
        window.webContents.send(IPC_EVENTS.SETTINGS_CHANGED, value);
      } catch (err) {
        console.error('settings: failed to broadcast settings:changed', err);
      }
    }
    return { ok: true, value };
  });
}
