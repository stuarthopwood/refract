// Shared theme metadata (spec 007 data-model.md "New shared types", contracts/ipc.md
// "Non-IPC: shared theme data"): imported directly by main, preload, and renderer -- the
// existing shared-module pattern (plan.md "Source code"), never served over IPC (research.md
// decision 3). The actual colour VALUES stay as CSS custom properties in
// `src/renderer/styles/globals.css`, one class per theme (`.theme-<id>`, e.g. `.theme-dark`,
// `.theme-dark-high-contrast`); this file only carries the small, reasoned metadata every
// process needs: the picker's name/swatch, which Shiki theme a code block uses, and the
// title-bar overlay colour main applies.

/** Additive: a further dark preset adds a key here, never removes `dark` or
 * `dark-high-contrast` (research.md decision 1). No `mode` field anywhere in this module --
 * every built-in theme is dark-toned, so there is nothing left to distinguish by mode. */
export type ThemeId = 'dark' | 'dark-high-contrast' | 'obsidian' | 'nordic-frost' | 'cyber-amber'

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
    // Matches `.theme-dark-high-contrast`'s own `--background` (pure black, globals.css) -- a
    // deliberately starker background than `dark`'s, maximising the margin above the WCAG AA
    // contrast floors every built-in theme must clear.
    swatch: '#000000',
    syntaxTheme: 'github-dark-high-contrast',
    titleBarOverlay: { color: '#000000', symbolColor: '#ffffff' }
  },
  // #550 (theme foundation, palette v2): a further dark preset, additive per the module comment
  // above -- the mock's own Obsidian canvas and palette, taken literally (`.theme-obsidian`,
  // globals.css): a blue-tinted slate canvas, very slightly lighter than `dark`'s near-black
  // (`#0a0a0a`), not darker -- `#0F1014`'s relative luminance (~0.0052) is marginally above
  // `#0a0a0a`'s (~0.0030).
  obsidian: {
    id: 'obsidian',
    name: 'Obsidian',
    swatch: '#0F1014',
    syntaxTheme: 'github-dark',
    titleBarOverlay: { color: '#0F1014', symbolColor: '#F8FAFC' }
  },
  // #551 (Nordic Frost / Cyber Amber dark presets): two further additive dark presets, built
  // out in full the same way #550 built Obsidian. Shiki theme choice (one of #551's own open
  // questions) -- **Decided (Skippy, delegated by Stuart 2026-10-18, revised at gate round 1):
  // both reuse `github-dark`.** Shiki's bundled `nord` theme was tried first for Nordic Frost
  // (an unambiguous name/palette match), but gate round 1 measured its own comment colour at
  // only 2.43:1 against this preset's `--card` -- under the 3:1 non-text floor every other
  // code-block surface in this app clears -- so it is reverted to `github-dark`, the same
  // "defer precise code-block tuning, Mermaid/Shiki colours are explicitly out of this story's
  // scope" precedent #550 set for Obsidian. Cyber Amber has no comparably-matching bundled
  // Shiki theme either, so it reuses `github-dark` too. A follow-up (filed separately as #975)
  // tracks giving each preset's code blocks their own `--card`-matched background instead of
  // reusing whatever a bundled Shiki theme ships with.
  'nordic-frost': {
    id: 'nordic-frost',
    name: 'Nordic Frost',
    // Matches `.theme-nordic-frost`'s own `--background` (globals.css): a deep navy canvas.
    swatch: '#060f1e',
    syntaxTheme: 'github-dark',
    titleBarOverlay: { color: '#060f1e', symbolColor: '#eff7fb' }
  },
  'cyber-amber': {
    id: 'cyber-amber',
    name: 'Cyber Amber',
    // Matches `.theme-cyber-amber`'s own `--background` (globals.css): a warm near-black canvas.
    swatch: '#0f0703',
    syntaxTheme: 'github-dark',
    titleBarOverlay: { color: '#0f0703', symbolColor: '#faf4ef' }
  }
}

// Quality-gate remediation (security-auditor, HIGH): the strict own-property check `theme.ts`
// already used, now shared by every site that validates an untrusted/persisted theme id
// (`isThemeId`, not the weaker `in` operator, which also matches a name inherited from
// `Object.prototype` -- e.g. a hand-corrupted settings.json with `"theme": "toString"`).
export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(THEMES, value)
}
