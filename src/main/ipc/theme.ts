// IPC handlers for `theme.*` (spec 007 contracts/ipc.md "Theme"), plus the one synchronous
// `theme:bootstrap` channel (contracts/ipc.md "Bootstrap"). Mirrors `ipc/settings.ts`'s own
// pattern: persist via `SettingsStore`, broadcast `settings:changed` on a real change, validate
// the caller's id before trusting it.

import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { IPC_REQUESTS, THEME_BOOTSTRAP_CHANNEL } from '../../shared/ipc';
import type { Result } from '../../shared/ipc';
import type { Settings } from '../../shared/model';
import { THEMES, isThemeId } from '../../shared/themes';
import type { ThemeId } from '../../shared/themes';
import type { SessionManager } from '../SessionManager';
import { applyTitleBarOverlay } from '../titleBarOverlay';
import { broadcastSettingsChanged } from './broadcast';

export function registerTheme(manager: SessionManager, getWindow: () => BrowserWindow | undefined): void {
  // `theme.preview` (FR-003 to FR-005, FR-017): live-only, never persisted. Moves only the
  // window's own title-bar overlay colour -- every other surface repaints in the renderer
  // directly from `theme-store.ts`'s derived class, no round trip needed for those (research.md
  // decision 7). `null` reverts the overlay to the currently SAVED theme (leaving preview).
  ipcMain.handle(IPC_REQUESTS.THEME_PREVIEW, async (_event, themeId: unknown): Promise<Result<void>> => {
    if (themeId !== null && !isThemeId(themeId)) {
      return { ok: false, error: { code: 'invalid-theme', message: `theme.preview expects a known theme id or null, got ${JSON.stringify(themeId)}` } };
    }
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      const savedTheme = manager.settings.get().theme;
      const resolvedId: ThemeId = themeId ?? (isThemeId(savedTheme) ? savedTheme : 'dark');
      // Quality-gate remediation (HIGH): a throw here (e.g. a destroyed/minimized window
      // rejecting the native overlay call) must never propagate out of the IPC handler --
      // nothing was persisted for `theme.preview` to begin with, so there is nothing else to
      // keep in sync; just don't crash the handler.
      try {
        applyTitleBarOverlay(window, THEMES[resolvedId].titleBarOverlay);
      } catch (err) {
        console.error('theme.preview: failed to apply title-bar overlay', err);
      }
    }
    return { ok: true, value: undefined };
  });

  // `theme.set` (FR-004): persists the choice as the one Refract starts in and follows
  // afterwards, applies the same title-bar overlay update for the new saved state, and
  // broadcasts `settings:changed` so every open window/pane picks it up immediately.
  ipcMain.handle(IPC_REQUESTS.THEME_SET, async (_event, themeId: unknown): Promise<Result<Settings>> => {
    if (!isThemeId(themeId)) {
      return { ok: false, error: { code: 'invalid-theme', message: `theme.set expects a known theme id, got ${JSON.stringify(themeId)}` } };
    }
    const next = await manager.settings.setTheme(themeId);
    // Quality-gate remediation (HIGH): broadcast BEFORE applying the overlay, and wrap the
    // overlay call in try/catch -- `settings.json` is already durably written by this point, so
    // if the native overlay call throws, every open window must still learn about the change
    // (the renderer's own CSS-class repaint doesn't depend on the overlay at all); previously a
    // throw here left the broadcast never sent, silently desyncing the renderer from disk.
    broadcastSettingsChanged(next, getWindow);
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      try {
        applyTitleBarOverlay(window, THEMES[themeId].titleBarOverlay);
      } catch (err) {
        console.error('theme.set: failed to apply title-bar overlay', err);
      }
    }
    return { ok: true, value: next };
  });

  // `theme:bootstrap` (contracts/ipc.md "Bootstrap"): synchronous, called once from `main.tsx`'s
  // very first lines before React mounts. Reads the already-loaded `SettingsStore` (synchronous
  // in main) -- `SettingsStore.open`'s own FR-013 fallback already guarantees `.theme` is a real
  // key of `THEMES` by the time this ever runs, so no further fallback is needed here. Not
  // `Result<T>`-shaped: there is nothing to fail (contracts/ipc.md).
  ipcMain.on(THEME_BOOTSTRAP_CHANNEL, (event) => {
    event.returnValue = { theme: manager.settings.get().theme };
  });
}
