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
    // `.theme-dark-high-contrast`'s own CSS custom properties (globals.css): `--background:
    // oklch(0 0 0)` (pure black, matching this theme's `swatch`), `--card: oklch(0.14 0 0)` ==
    // `#090909`, `--border: oklch(0.6 0 0)` == `#808080`, `--muted-foreground: oklch(0.85 0 0)`
    // == `#cecece`, `--secondary`/`--muted: oklch(0.26 0 0)` == `#242424`. Node fill/border/line
    // colours below are those real values, not pure black/white placeholders, so a diagram reads
    // visually consistent with every other panel in this theme (dialogs, cards, the message box).
    background: '#000000',
    primaryColor: '#090909',
    primaryTextColor: '#ffffff',
    primaryBorderColor: '#808080',
    lineColor: '#cecece',
    // Multi-fill diagrams still need to tell fills apart at this theme's own higher contrast
    // bar; `secondaryColor` matches `--secondary`/`--muted`, `tertiaryColor` is one step lighter
    // again so a three-way diagram stays distinguishable, same pattern as the `dark` mapping.
    secondaryColor: '#242424',
    tertiaryColor: '#363636',
    textColor: '#ffffff'
  }
}
