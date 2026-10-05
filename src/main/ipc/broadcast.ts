// Quality-gate remediation (code-reviewer, Medium -- DRY): `ipc/settings.ts` and `ipc/theme.ts`
// each defined their own identical `broadcastSettingsChanged` helper. One shared implementation,
// used by both -- `settings:changed` is a single notification every settings-shaped mutation
// (approval mode, readout visibility, split, theme) already needs to send the same way.

import type { BrowserWindow } from 'electron';
import { IPC_EVENTS } from '../../shared/ipc';
import type { Settings } from '../../shared/model';

export function broadcastSettingsChanged(value: Settings, getWindow: () => BrowserWindow | undefined): void {
  const window = getWindow();
  if (window && !window.isDestroyed()) {
    try {
      window.webContents.send(IPC_EVENTS.SETTINGS_CHANGED, value);
    } catch (err) {
      console.error('settings: failed to broadcast settings:changed', err);
    }
  }
}
