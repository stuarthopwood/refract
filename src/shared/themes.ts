// Shared theme metadata for main, preload and renderer. Colour values live in globals.css
// (`.theme-<id>`); this carries the picker name/swatch, Shiki theme and title-bar overlay colour.

/** The one Shiki theme whose colours are CSS custom properties (#456). */
export const CSS_VARIABLES_SYNTAX_THEME = 'css-variables'

/** Additive: a further preset adds a key. light-toned ids are listed in `LIGHT_THEME_IDS`, every other id is dark-toned (see `isLightTheme`). */
export type ThemeId =
  | 'dark'
  | 'dark-high-contrast'
  | 'obsidian'
  | 'amber-obsidian'
  | 'nordic-frost'
  | 'cyber-amber'
  | 'light'
  | 'light-warm-paper'
  | 'light-high-contrast'
  | 'lagoon'
  | 'amethyst'
  | 'hearth'
  | 'solarized-light'
  | 'github-light'
  | 'catppuccin-latte'
  | 'one-light'
  | 'gruvbox-light'
  | 'rose-pine-dawn'
  | 'dracula'
  | 'nord'
  | 'tokyo-night'
  | 'catppuccin-mocha'
  | 'gruvbox-dark'
  | 'solarized-dark'
  | 'one-dark'

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
  'amber-obsidian': {
    id: 'amber-obsidian',
    name: 'Amber Obsidian',
    swatch: '#0F1014',
    swatchPrimary: '#fcc527',
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
  },
  light: {
    id: 'light',
    name: 'Light',
    swatch: '#ffffff',
    swatchPrimary: '#262626',
    syntaxTheme: 'css-variables',
    titleBarOverlay: { color: '#e9e9e9', symbolColor: '#171717' }
  },
  'light-warm-paper': {
    id: 'light-warm-paper',
    name: 'Light (warm paper)',
    swatch: '#faf3e5',
    swatchPrimary: '#7d460b',
    syntaxTheme: 'css-variables',
    titleBarOverlay: { color: '#e9e0d0', symbolColor: '#171615' }
  },
  'light-high-contrast': {
    id: 'light-high-contrast',
    name: 'Light (high contrast)',
    swatch: '#ffffff',
    swatchPrimary: '#000000',
    syntaxTheme: 'css-variables',
    titleBarOverlay: { color: '#e9e9e9', symbolColor: '#000000' }
  },
  lagoon: {
    id: 'lagoon',
    name: 'Lagoon',
    swatch: '#021113',
    swatchPrimary: '#007475',
    syntaxTheme: 'css-variables',
    titleBarOverlay: { color: '#06272b', symbolColor: '#e6e9ea' }
  },
  amethyst: {
    id: 'amethyst',
    name: 'Amethyst',
    swatch: '#100b19',
    swatchPrimary: '#773ac1',
    syntaxTheme: 'css-variables',
    titleBarOverlay: { color: '#271f35', symbolColor: '#e9e9eb' }
  },
  hearth: {
    id: 'hearth',
    name: 'Hearth',
    swatch: '#160b07',
    swatchPrimary: '#9f4500',
    syntaxTheme: 'css-variables',
    titleBarOverlay: { color: '#311f16', symbolColor: '#eae9e8' }
  },
  'solarized-light': {
    id: 'solarized-light',
    name: 'Solarized Light',
    swatch: '#fdf6e3',
    swatchPrimary: '#1b6aa5',
    syntaxTheme: 'css-variables',
    titleBarOverlay: { color: '#eeead9', symbolColor: '#073642' }
  },
  'github-light': {
    id: 'github-light',
    name: 'GitHub Light',
    swatch: '#ffffff',
    swatchPrimary: '#0969da',
    syntaxTheme: 'css-variables',
    titleBarOverlay: { color: '#f2f2f2', symbolColor: '#1f2328' }
  },
  'catppuccin-latte': {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    swatch: '#eff1f5',
    swatchPrimary: '#8839ef',
    syntaxTheme: 'css-variables',
    titleBarOverlay: { color: '#e5e7ed', symbolColor: '#4c4f69' }
  },
  'one-light': {
    id: 'one-light',
    name: 'One Light',
    swatch: '#fafafa',
    swatchPrimary: '#2f62d9',
    syntaxTheme: 'css-variables',
    titleBarOverlay: { color: '#eeeeef', symbolColor: '#383a42' }
  },
  'gruvbox-light': {
    id: 'gruvbox-light',
    name: 'Gruvbox Light',
    swatch: '#fbf1c7',
    swatchPrimary: '#af3a03',
    syntaxTheme: 'css-variables',
    titleBarOverlay: { color: '#f0e6be', symbolColor: '#3c3836' }
  },
  'rose-pine-dawn': {
    id: 'rose-pine-dawn',
    name: 'Rose Pine Dawn',
    swatch: '#faf4ed',
    swatchPrimary: '#286983',
    syntaxTheme: 'css-variables',
    titleBarOverlay: { color: '#f0eae6', symbolColor: '#575279' }
  },
  dracula: {
    id: 'dracula',
    name: 'Dracula',
    swatch: '#282a36',
    swatchPrimary: '#bd93f9',
    syntaxTheme: 'css-variables',
    titleBarOverlay: { color: '#32333f', symbolColor: '#fcfcf9' }
  },
  nord: {
    id: 'nord',
    name: 'Nord',
    swatch: '#2e3440',
    swatchPrimary: '#81a1c1',
    syntaxTheme: 'css-variables',
    titleBarOverlay: { color: '#343a46', symbolColor: '#f9fafc' }
  },
  'tokyo-night': {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    swatch: '#1a1b26',
    swatchPrimary: '#7aa2f7',
    syntaxTheme: 'css-variables',
    titleBarOverlay: { color: '#232430', symbolColor: '#e0e5fa' }
  },
  'catppuccin-mocha': {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    swatch: '#1e1e2e',
    swatchPrimary: '#cba6f7',
    syntaxTheme: 'css-variables',
    titleBarOverlay: { color: '#272737', symbolColor: '#e6eaf9' }
  },
  'gruvbox-dark': {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    swatch: '#282828',
    swatchPrimary: '#d79921',
    syntaxTheme: 'css-variables',
    titleBarOverlay: { color: '#313131', symbolColor: '#f9f5e9' }
  },
  'solarized-dark': {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    swatch: '#002b36',
    swatchPrimary: '#1f77b8',
    syntaxTheme: 'css-variables',
    titleBarOverlay: { color: '#0b343e', symbolColor: '#f8f5ed' }
  },
  'one-dark': {
    id: 'one-dark',
    name: 'One Dark',
    swatch: '#282c34',
    swatchPrimary: '#61afef',
    syntaxTheme: 'css-variables',
    titleBarOverlay: { color: '#30343c', symbolColor: '#f2f3f5' }
  }
}

/** Strict own-property check for untrusted theme ids; `in` would match inherited names like `toString`. */
export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(THEMES, value)
}

/** True for the light-toned presets; they get the `light` class and light Mermaid/toast branches. */
const LIGHT_THEME_IDS: ReadonlySet<ThemeId> = new Set<ThemeId>([
  'light',
  'light-warm-paper',
  'light-high-contrast',
  'solarized-light',
  'github-light',
  'catppuccin-latte',
  'one-light',
  'gruvbox-light',
  'rose-pine-dawn'
])

export function isLightTheme(id: ThemeId): boolean {
  return LIGHT_THEME_IDS.has(id)
}
