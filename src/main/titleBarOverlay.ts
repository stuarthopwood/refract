// The title-bar overlay colours (spec 001 T100; `BrowserWindow.setTitleBarOverlay`, Windows only
// since `titleBarStyle: 'hidden'` merges the title bar into the app's own top row). Electron
// wants plain sRGB hex, not `oklch()`, so these are the dark theme's `--background`/`--foreground`
// tokens (`src/renderer/styles/globals.css` `.dark`) converted once by hand (oklch(0.145 0 0) ->
// #0a0a0a, oklch(0.985 0 0) -> #fafafa). Refract is dark-only today (docs/DESIGN.md "Look and
// feel"); spec 007 will replace this constant with the active theme's own colours and call
// `applyTitleBarOverlay` again from its `theme.preview`/`theme.set` IPC handlers whenever the
// user changes theme (its own `getWindow()?.setTitleBarOverlay(...)` call, same shape as this).
import type { BrowserWindow } from 'electron';

export const DARK_TITLE_BAR_OVERLAY = {
  color: '#0a0a0a',
  symbolColor: '#fafafa',
  height: 40,
} as const;

export function applyTitleBarOverlay(window: BrowserWindow): void {
  window.setTitleBarOverlay(DARK_TITLE_BAR_OVERLAY);
}
