// IPC handlers for `settings.*` (contracts/ipc.md "Settings"). `setApprovalMode` persists the
// mode, then fans `pendingMode` out to every live Session via
// `SessionManager.applyPendingModeChange` (T031); each restarts at its own next settle
// (`SessionAgent.restart`, T032). Also broadcasts `settings:changed` so the renderer's store
// stays in sync even when a caller reaches `window.refract.settings.setApprovalMode` directly
// instead of through the store's own action (that action already self-updates from the IPC
// call's return value, but the broadcast is the only sync path for every other caller).

import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { Result } from '../../shared/ipc';
import type { ApprovalMode, ReadoutKind, Settings, SplitLayout } from '../../shared/model';
import type { SessionManager } from '../SessionManager';
import { broadcastSettingsChanged } from './broadcast';

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

  // Spec 005 contracts/ipc.md `settings.setSplit`: basic-shape validation only (invalid-argument
  // for a malformed payload) -- the renderer only ever calls this with ids it already knows are
  // valid (its own split-store's current pane ids); registry validation against archived/deleted
  // sessions happens separately, once, at app start (index.ts, FR-015).
  //
  // Quality-gate remediation (security-auditor, HIGH): `typeof layout !== 'object'` let an Array
  // through (`typeof [] === 'object'`), and every field below was read off the CALLER'S object
  // and then that same object was persisted verbatim -- an array with `sessionIds`/`dividerPercent`/
  // `focusedIndex` set as extra named properties (survives Electron's structured-clone IPC) passed
  // every check here but serialised to `"split": []` in settings.json, which `validateSplitAtStartup`
  // (index.ts) had no shape check against -- `[].sessionIds.filter` throws on the next launch,
  // inside an uncaught `app.whenReady().then`, permanently preventing the window from ever opening.
  // Now: Array is rejected explicitly, every field is validated by direct index/property read (never
  // `.every()`, which silently skips a sparse array's holes), and only a freshly-built, exactly-
  // shaped object is ever persisted -- the caller's own object (and any extra property on it) is
  // never stored. `SettingsStore.open`'s own shape check (store/settings.ts) is the second,
  // independent layer against a hand-edited or already-corrupt settings.json.
  ipcMain.handle(IPC_REQUESTS.SETTINGS_SET_SPLIT, async (_event, layout: unknown): Promise<Result<Settings>> => {
    let validated: SplitLayout | null = null;
    if (layout !== null) {
      if (typeof layout !== 'object' || Array.isArray(layout)) {
        return { ok: false, error: { code: 'invalid-argument', message: `${IPC_REQUESTS.SETTINGS_SET_SPLIT} expects a SplitLayout or null` } };
      }
      const { sessionIds, dividerPercent, focusedIndex } = layout as Partial<SplitLayout>;
      const first = Array.isArray(sessionIds) ? sessionIds[0] : undefined;
      const second = Array.isArray(sessionIds) ? sessionIds[1] : undefined;
      const validSessionIds =
        Array.isArray(sessionIds) && sessionIds.length === 2 && typeof first === 'string' && typeof second === 'string' && first !== second;
      const validDividerPercent =
        typeof dividerPercent === 'number' && Number.isFinite(dividerPercent) && dividerPercent >= 0 && dividerPercent <= 100;
      const validFocusedIndex = focusedIndex === 0 || focusedIndex === 1;
      if (!validSessionIds || !validDividerPercent || !validFocusedIndex) {
        return {
          ok: false,
          error: {
            code: 'invalid-argument',
            message: `${IPC_REQUESTS.SETTINGS_SET_SPLIT} expects { sessionIds: [string, string] (distinct), dividerPercent: 0-100, focusedIndex: 0 | 1 } or null`,
          },
        };
      }
      validated = { sessionIds: [first as string, second as string], dividerPercent: dividerPercent as number, focusedIndex: focusedIndex as 0 | 1 };
    }
    const value = await manager.settings.setSplit(validated);
    broadcastSettingsChanged(value, getWindow);
    return { ok: true, value };
  });

  // Spec 012 contracts/ipc.md `settings.setWatermarkEnabled` (FR-015 to FR-020): a non-boolean
  // argument is the existing `invalid-argument` error code, the same catch-all `setSplit`'s own
  // malformed-payload branch above already uses.
  ipcMain.handle(IPC_REQUESTS.SETTINGS_SET_WATERMARK_ENABLED, async (_event, enabled: unknown): Promise<Result<Settings>> => {
    if (typeof enabled !== 'boolean') {
      return {
        ok: false,
        error: { code: 'invalid-argument', message: `${IPC_REQUESTS.SETTINGS_SET_WATERMARK_ENABLED} expects a boolean enabled` },
      };
    }
    const value = await manager.settings.setWatermarkEnabled(enabled);
    broadcastSettingsChanged(value, getWindow);
    return { ok: true, value };
  });

  // Issue #457: two independent view-filter switches (Show thinking output / Show tool
  // calls), the same immediate-apply + basic-shape-validation pattern as
  // `SETTINGS_SET_WATERMARK_ENABLED` above. Quality-gate remediation (HIGH): takes ONE field
  // at a time (not the whole `TranscriptDisplaySettings` object) and merges it in
  // `SettingsStore.setTranscriptDisplay`, the same per-field pattern `SETTINGS_SET_READOUT_
  // VISIBILITY` already uses -- a whole-object payload let a quick second toggle (built from
  // the renderer's stale pre-write value of the first field) silently revert it.
  ipcMain.handle(IPC_REQUESTS.SETTINGS_SET_TRANSCRIPT_DISPLAY, async (_event, field: unknown, visible: unknown): Promise<Result<Settings>> => {
    if (field !== 'thinking' && field !== 'toolCalls') {
      return {
        ok: false,
        error: { code: 'invalid-argument', message: `${IPC_REQUESTS.SETTINGS_SET_TRANSCRIPT_DISPLAY} expects field 'thinking' | 'toolCalls'` },
      };
    }
    if (typeof visible !== 'boolean') {
      return {
        ok: false,
        error: { code: 'invalid-argument', message: `${IPC_REQUESTS.SETTINGS_SET_TRANSCRIPT_DISPLAY} expects a boolean visible` },
      };
    }
    const value = await manager.settings.setTranscriptDisplay(field, visible);
    broadcastSettingsChanged(value, getWindow);
    return { ok: true, value };
  });
}
