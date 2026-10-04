// Mermaid colour mapping (spec 007 T017, research.md decision 10): each `ThemeDefinition`'s
// own look, translated into Mermaid's `themeVariables` config object. `Markdown.tsx`'s
// `MermaidBlock` initializes Mermaid with `theme: 'base'` (not a named theme like `'dark'`/
// `'default'`) specifically so these overrides take full effect -- Mermaid's named themes only
// partially honour a custom `themeVariables` object (research.md decision 10's rejected
// alternative).
import type { ThemeId } from './themes'

// Mermaid's own published `MermaidConfig['themeVariables']` (node_modules/mermaid/dist/
// config.type.d.ts) is typed `any` -- there is no exported `ThemeVariables` interface to extend
// here. This interface is this app's own typed subset of the keys it actually sets, covering
// flowchart/sequence/class diagram basics only (research.md decision 10): not Mermaid's full
// variable surface.
export interface MermaidThemeVariables {
  /** Canvas background; matches the theme's own `--background`. */
  background: string
  /** Node fill colour; matches the theme's own `--card`. */
  primaryColor: string
  /** Node label text colour; matches the theme's own `--card-foreground`. */
  primaryTextColor: string
  /** Node border colour; matches the theme's own `--border`. */
  primaryBorderColor: string
  /** Edge/connector line colour; matches the theme's own `--muted-foreground`. */
  lineColor: string
  /** Second node-fill colour for multi-coloured diagram types (class/state diagrams); matches
   * the theme's own `--secondary`/`--muted`. */
  secondaryColor: string
  /** Third node-fill colour for multi-coloured diagram types; one step lighter than
   * `secondaryColor` so a three-way diagram still reads as distinct fills. */
  tertiaryColor: string
  /** General text colour (titles, notes); matches the theme's own `--foreground`. */
  textColor: string
}

/** Picker order mirrors `THEMES` (additive: a further dark preset adds a key here too, per
 * research.md decision 1). */
export const MERMAID_THEME_VARIABLES: Record<ThemeId, MermaidThemeVariables> = {
  dark: {
    // `.theme-dark`'s `--background: oklch(0.145 0 0)` == its own `swatch`, `#0a0a0a`.
    background: '#0a0a0a',
    // `--card: oklch(0.205 0 0)` / `--card-foreground: oklch(0.985 0 0)` / `--border: oklch(1 0 0
    // / 10%)` (a near-invisible overlay border over this dark background in CSS; opaque here
    // since Mermaid strokes need a solid colour) -- approximated as a mid-grey border that reads
    // against both the card fill and the page background.
    primaryColor: '#1f1f1f',
    primaryTextColor: '#fafafa',
    primaryBorderColor: '#4d4d4d',
    // `--muted-foreground: oklch(0.708 0 0)`.
    lineColor: '#b5b5b5',
    // `--secondary`/`--muted`: oklch(0.269 0 0); `--accent`: the same value again, so a third
    // distinct fill is picked one step lighter to stay distinguishable from both.
    secondaryColor: '#2b2b2b',
    tertiaryColor: '#3d3d3d',
    // `--foreground: oklch(0.985 0 0)`.
    textColor: '#fafafa'
  },
  'dark-high-contrast': {
    // `.theme-dark-high-contrast`'s `--background` is specified as pure black (`oklch(0 0 0)`,
    // matching its own `swatch`, `#000000`) -- its full token set is not yet landed in
    // globals.css (a later task fills in `.theme-dark-high-contrast {}`, currently empty), so
    // these values are chosen directly from `ThemeDefinition`'s own stated max-contrast intent
    // (FR-008, FR-010: "maximising the margin above WCAG AA's 4.5:1/3:1 floors") rather than
    // copied from an existing CSS block: pure black/white with no intermediate grey softening,
    // the same way its `titleBarOverlay` already pairs `#000000` with `#ffffff`.
    background: '#000000',
    primaryColor: '#000000',
    primaryTextColor: '#ffffff',
    primaryBorderColor: '#ffffff',
    lineColor: '#ffffff',
    // Multi-fill diagrams still need to tell fills apart even at this theme's max-contrast
    // extreme; these stay dark (never mid-grey) so no fill reads as "washed out" next to a pure
    // black background, while remaining visibly distinct from `primaryColor`'s pure black.
    secondaryColor: '#1a1a1a',
    tertiaryColor: '#333333',
    textColor: '#ffffff'
  }
}
