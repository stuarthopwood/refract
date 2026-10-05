// The title-bar overlay colours (spec 001 T100; `BrowserWindow.setTitleBarOverlay`, Windows only
// since `titleBarStyle: 'hidden'` merges the title bar into the app's own top row). Electron
// wants plain sRGB hex, not `oklch()`, so each theme's own `titleBarOverlay` (src/shared/
// themes.ts) is already converted by hand from its CSS `--background`/`--foreground` tokens
// (src/renderer/styles/globals.css). `height` is theme-independent window-chrome geometry, so it
// stays a constant here rather than living on every `ThemeDefinition` (data-model.md).
import type { BrowserWindow } from 'electron';

export const TITLE_BAR_OVERLAY_HEIGHT = 40;

export function applyTitleBarOverlay(window: BrowserWindow, overlay: { color: string; symbolColor: string }): void {
  window.setTitleBarOverlay({ ...overlay, height: TITLE_BAR_OVERLAY_HEIGHT });
}
