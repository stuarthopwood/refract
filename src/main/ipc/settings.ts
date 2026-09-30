// IPC handlers for `settings.*` (contracts/ipc.md "Settings"). `setApprovalMode` persists the
// mode, then fans `pendingMode` out to every live Session via
// `SessionManager.applyPendingModeChange` (T031); each restarts at its own next settle
// (`SessionAgent.restart`, T032).

import { ipcMain } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { Result } from '../../shared/ipc';
import type { ApprovalMode, Settings } from '../../shared/model';
import type { SessionManager } from '../SessionManager';

const APPROVAL_MODES: Record<ApprovalMode, true> = { ask: true, 'edit-freely': true, auto: true };

export function registerSettings(manager: SessionManager): void {
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
    return { ok: true, value };
  });
}
