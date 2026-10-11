// Theme-independent window-chrome geometry shared between main (`titleBarOverlay.ts`, the real
// `BrowserWindow.setTitleBarOverlay` height) and the renderer (spec 013: the right-pane icon
// rail's own top spacer, so its first button never sits under the window's caption buttons).
// A single source avoids the two ever drifting apart.
export const TITLE_BAR_OVERLAY_HEIGHT = 40
