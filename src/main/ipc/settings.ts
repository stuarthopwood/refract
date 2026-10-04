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
import type { ApprovalMode, ReadoutKind, Settings } from '../../shared/model';
import type { SessionManager } from '../SessionManager';

const APPROVAL_MODES: Record<ApprovalMode, true> = { ask: true, 'edit-freely': true, auto: true };

// Spec 004 FR-012 to FR-014: every valid ReadoutKind, for the same defensive-validate-before-cast
// pattern APPROVAL_MODES already uses above.
const READOUT_KINDS: Record<ReadoutKind, true> = {
  changes: true,
  'context-usage': true,
  'turn-time': true,
  'current-time': true,
  'pull-request': true,
  subagents: true,
  'todo-progress': true,
};

function broadcastSettingsChanged(value: Settings, getWindow: () => BrowserWindow | undefined): void {
  const window = getWindow();
  if (window && !window.isDestroyed()) {
    try {
      window.webContents.send(IPC_EVENTS.SETTINGS_CHANGED, value);
    } catch (err) {
      console.error('settings: failed to broadcast settings:changed', err);
    }
  }
}

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
    broadcastSettingsChanged(value, getWindow);
    return { ok: true, value };
  });

  ipcMain.handle(IPC_REQUESTS.SETTINGS_SET_READOUT_VISIBILITY, async (_event, kind: unknown, visible: unknown): Promise<Result<Settings>> => {
    if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(READOUT_KINDS, kind)) {
      return {
        ok: false,
        error: { code: 'invalid-argument', message: `${IPC_REQUESTS.SETTINGS_SET_READOUT_VISIBILITY} expects a known ReadoutKind` },
      };
    }
    if (typeof visible !== 'boolean') {
      return {
        ok: false,
        error: { code: 'invalid-argument', message: `${IPC_REQUESTS.SETTINGS_SET_READOUT_VISIBILITY} expects a boolean visible` },
      };
    }
    const value = await manager.settings.setReadoutVisibility(kind as ReadoutKind, visible);
    broadcastSettingsChanged(value, getWindow);
    return { ok: true, value };
  });
}
