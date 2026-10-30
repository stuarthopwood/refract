// Shared theme metadata for main, preload and renderer. Colour values live in globals.css
// (`.theme-<id>`); this carries the picker name/swatch, Shiki theme and title-bar overlay colour.

/** The one Shiki theme whose colours are CSS custom properties (#456). */
export const CSS_VARIABLES_SYNTAX_THEME = 'css-variables'

/** Additive: a further dark preset adds a key; every built-in theme is dark-toned, so there is no `mode`. */
export type ThemeId = 'dark' | 'dark-high-contrast' | 'obsidian' | 'nordic-frost' | 'cyber-amber'

export interface ThemeDefinition {
  id: ThemeId
  /** Shown in the picker next to the swatch. */
  name: string
  /** The theme's own `--background` value, shown next to `name` in the picker. */
  swatch: string
  /** The theme's `--primary` value (literal, matching globals.css), paired with `swatch` as a landscape chip (#1043). */
  swatchPrimary: string
  /** A Shiki bundled theme id, or `css-variables` (#456): colours then come from the preset's own `--syntax-*` tokens in globals.css (Dark (high contrast) keeps its bundled Shiki theme). */
  syntaxTheme: string
  /** `BrowserWindow.setTitleBarOverlay` colours; `height` lives in `titleBarOverlay.ts`. */
  titleBarOverlay: {
    color: string
    symbolColor: string
  }
}

/** Picker order: `Object.values(THEMES)` preserves insertion order. */
export const THEMES: Record<ThemeId, ThemeDefinition> = {
  dark: {
    id: 'dark',
    name: 'Dark',
    swatch: '#0a0a0a',
    swatchPrimary: '#e5e5e5',
    syntaxTheme: 'css-variables',
    // setTitleBarOverlay takes opaque hex, so `symbolColor` is `--foreground` (white at 90%) composited over `--titlebar`
    // (#1074, #682); `check-theme-contrast.mjs` verifies the drift.
    titleBarOverlay: { color: '#171717', symbolColor: '#e8e8e8' }
  },
  'dark-high-contrast': {
    id: 'dark-high-contrast',
    name: 'Dark (high contrast)',
    swatch: '#000000',
    swatchPrimary: '#ffffff',
    syntaxTheme: 'github-dark-high-contrast',
    titleBarOverlay: { color: '#090909', symbolColor: '#ffffff' }
  },
  obsidian: {
    id: 'obsidian',
    name: 'Obsidian',
    swatch: '#0F1014',
    swatchPrimary: '#5A5EEE',
    syntaxTheme: 'css-variables',
    titleBarOverlay: { color: '#1c1f28', symbolColor: '#e8e9e9' }
  },
  // Code-block backgrounds follow each preset's `--card` (via Shiki `colorReplacements`), and `css-variables` keeps
  // token colours clearing the 4.5:1 floor, which `github-dark`'s comment colour cannot (#975).
  'nordic-frost': {
    id: 'nordic-frost',
    name: 'Nordic Frost',
    swatch: '#060f1e',
    swatchPrimary: '#007a7c',
    syntaxTheme: 'css-variables',
    titleBarOverlay: { color: '#101b2b', symbolColor: '#e7e8ea' }
  },
  'cyber-amber': {
    id: 'cyber-amber',
    name: 'Cyber Amber',
    // Byte-identical to Dark's background; `check-theme-contrast.mjs` fails until both follow (#1256).
    swatch: '#0a0a0a',
    swatchPrimary: '#c2410c',
    syntaxTheme: 'css-variables',
    titleBarOverlay: { color: '#171717', symbolColor: '#e8e8e8' }
  }
}

/** Strict own-property check for untrusted theme ids; `in` would match inherited names like `toString`. */
export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(THEMES, value)
}
