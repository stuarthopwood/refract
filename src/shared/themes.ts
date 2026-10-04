// Shared theme metadata (spec 007 data-model.md "New shared types", contracts/ipc.md
// "Non-IPC: shared theme data"): imported directly by main, preload, and renderer -- the
// existing shared-module pattern (plan.md "Source code"), never served over IPC (research.md
// decision 3). The actual colour VALUES stay as CSS custom properties in
// `src/renderer/styles/globals.css`, one class per theme (`.theme-dark`,
// `.theme-dark-high-contrast`); this file only carries the small, reasoned metadata every
// process needs: the picker's name/swatch, which Shiki theme a code block uses, and the
// title-bar overlay colour main applies.

/** Additive: a further dark preset adds a key here, never removes `dark` or
 * `dark-high-contrast` (research.md decision 1). No `mode` field anywhere in this module --
 * every built-in theme is dark-toned, so there is nothing left to distinguish by mode. */
export type ThemeId = 'dark' | 'dark-high-contrast'

export interface ThemeDefinition {
  id: ThemeId
  /** Shown in the picker next to the swatch, e.g. "Dark", "Dark (high contrast)". */
  name: string
  /** A representative CSS colour shown next to `name` in the picker -- each theme's own
   * `--background` value, so the swatch is literally that theme's real window colour rather
   * than an arbitrary accent. */
  swatch: string
  /** A Shiki bundled theme id (research.md decision 9, confirmed live: FINDINGS.md item 42). */
  syntaxTheme: string
  /** `BrowserWindow.setTitleBarOverlay` colours (spec 001 T100); `height` is theme-independent
   * window-chrome geometry, so it stays a constant in `titleBarOverlay.ts`, not here. */
  titleBarOverlay: {
    color: string
    symbolColor: string
  }
}

/** Picker order (FR-001): `dark`, `dark-high-contrast`, then any further preset in declaration
 * order -- `Object.values(THEMES)` below preserves insertion order for string keys. */
export const THEMES: Record<ThemeId, ThemeDefinition> = {
  dark: {
    id: 'dark',
    name: 'Dark',
    // Matches `.theme-dark`'s own `--background: oklch(0.145 0 0)` (globals.css), converted by
    // hand the same way `titleBarOverlay.ts` already converts it for Electron's sRGB-only API.
    swatch: '#0a0a0a',
    syntaxTheme: 'github-dark',
    titleBarOverlay: { color: '#0a0a0a', symbolColor: '#fafafa' }
  },
  'dark-high-contrast': {
    id: 'dark-high-contrast',
    name: 'Dark (high contrast)',
    // Matches `.theme-dark-high-contrast`'s own `--background: oklch(0 0 0)` (pure black,
    // globals.css) -- a deliberately starker background than `dark`'s, maximising the margin
    // above the WCAG AA contrast floors every built-in theme must clear.
    swatch: '#000000',
    syntaxTheme: 'github-dark-high-contrast',
    titleBarOverlay: { color: '#000000', symbolColor: '#ffffff' }
  }
}
