// Mermaid colour mapping (spec 007 T017, research.md decision 10): each `ThemeDefinition`'s
// own look, translated into a small override layered on top of Mermaid's own built-in `'dark'`
// theme. `Markdown.tsx`'s `MermaidBlock` initializes Mermaid with `theme: 'dark'` (not `'base'`).
//
// Quality-gate remediation (High, round 2): an earlier version of this file used `theme: 'base'`
// (Mermaid's colourless starting point) and hand-built a full `themeVariables` set to patch every
// element Mermaid's `theme-base.js` would otherwise fall back to light-mode colours for. That
// whack-a-mole approach was fixed one diagram type at a time across two review rounds and still
// missed real contrast failures: pie slices and mindmap/timeline/journey section fills derived
// from a dark `primaryColor` collapsed to near-black-on-near-black (measured ~1.1-2.5:1), and
// Gantt's `taskTextDarkColor`/`taskTextClickableColor` (dark text meant to sit on a light task
// bar, but also used for a task's label when it overflows OUTSIDE the bar onto the dark page
// background) measured ~1.4-1.5:1.
//
// Mermaid's own built-in `'dark'` theme (node_modules/mermaid/dist's `theme-dark.js`) already
// derives a reasonable set of colours for most of its surface from `background`/`primaryColor`/
// `textColor` alone -- flowchart, sequence, ER, class diagrams, and Gantt's grid/done/active/crit/
// exclude-range/today-line bands all measured correctly (>=3:1 non-text, >=4.5:1 text) in a real
// mermaid@11.17.2 render with only those overridden. The two families above derive from a dark
// `primaryColor`/from a context-insensitive dark-text constant and stay broken regardless of
// `darkMode`/`theme`, so this file explicitly overrides their specific variables too, verified by
// rendering every diagram type with the real pinned package (scripts/check-mermaid-contrast.mjs).
import type { ThemeId } from './themes'

// Mermaid's own published `MermaidConfig['themeVariables']` (node_modules/mermaid/dist/
// config.type.d.ts) is typed `any` -- there is no exported `ThemeVariables` interface to extend
// here. This interface is this app's own typed subset of the keys it actually sets: the small set
// each Refract theme needs on top of Mermaid's `'dark'` base (research.md decision 10), not
// Mermaid's full variable surface.
export interface MermaidThemeVariables {
  /** Canvas background; matches the theme's own `--background`. */
  background: string
  /** Node fill colour; matches the theme's own `--card`. */
  primaryColor: string
  /** Node label text colour; matches the theme's own `--card-foreground`. */
  primaryTextColor: string
  /** Node border colour; matches the theme's own opaque `--border` token (quality-gate
   * remediation, round 2: a prior value here, `#4d4d4d`, was under 2:1 against both the node
   * fill and the page background -- under WCAG's 3:1 non-text floor -- because it didn't match
   * `--border`'s real resolved value). */
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
  /** Tells mermaid to resolve its own internal light/dark derivations against a dark background;
   * redundant with the `'dark'` base theme but kept explicit since some derivations key off it
   * directly rather than off the base theme name. */
  darkMode: true
  /** Gantt's alternating section-row background (quality-gate remediation, round 2: this key
   * affects ONLY Gantt section stripes -- it has no effect on ER-diagram attribute rows; those
   * alternate via `darkMode` + `mainBkg`, which Mermaid's `'dark'` base already derives
   * correctly, which is why this file no longer overrides any ER-specific variable). Matches the
   * theme's own `--muted`/`--secondary`. */
  altSectionBkgColor: string
  /** Note shape fill; matches the theme's own `--popover`. */
  noteBkgColor: string
  /** Note shape text colour; matches the theme's own `--popover-foreground`. */
  noteTextColor: string
  /** Gantt task-label colour used ONLY when a label overflows outside its task bar onto the page
   * background (quality-gate remediation, round 2: Mermaid's own default here, `taskTextDarkColor`
   * paired with a light task-bar fill, measured ~1.4:1 against this app's dark background once the
   * label spills outside the bar it was meant to sit on). Matches `textColor`. */
  taskTextDarkColor: string
  /** Gantt clickable-task label colour; matches the theme's own `--primary`-ish accent so a
   * clickable task reads as interactive against the dark background (quality-gate remediation,
   * round 2: Mermaid's default here, `#003163`, measured ~1.5:1 against this app's background). */
  taskTextClickableColor: string
  /** Pie-slice fills (quality-gate remediation, round 2: Mermaid derives these from
   * `primaryColor`, which collapses to near-black-on-near-black once `primaryColor` itself is a
   * dark node-fill colour -- measured ~1.1-2.5:1 between adjacent slices and against the page
   * background). A fixed, hue-separated, high-lightness palette instead: each colour measures
   * >=8.3:1 against both this app's dark backgrounds and the `pieSectionTextColor` label colour
   * below, regardless of which Refract theme is active (the page background is near-black in
   * both), so one palette serves every theme. */
  pie1: string
  pie2: string
  pie3: string
  pie4: string
  pie5: string
  pie6: string
  pie7: string
  pie8: string
  /** Slice opacity; Mermaid's own default (0.7) blends each slice toward the page background,
   * undoing part of the palette's contrast margin above. Full opacity keeps the measured ratios. */
  pieOpacity: number
  /** Percentage-label text colour, drawn INSIDE each slice; Mermaid's own default here reuses
   * `textColor` (this app's near-white), which is illegible on the light palette above. Black
   * reads at >=8.3:1 against every colour in that palette. */
  pieSectionTextColor: string
  /** Slice border, separating adjacent slices even where two palette colours are closer in
   * lightness; Mermaid's own default is a literal `black`, invisible on a near-black page
   * background. Matches `primaryBorderColor`. */
  pieStrokeColor: string
  /** Outer ring border; same reasoning as `pieStrokeColor`. Matches `lineColor`. */
  pieOuterStrokeColor: string
  /** Mindmap/timeline/journey section fills (`cScale0`-`cScale7`, Mermaid's `THEME_COLOR_LIMIT`
   * default); quality-gate remediation, round 2: same `primaryColor`-derived collapse as the pie
   * palette above (a prior reviewer's report of "node fills pure black on black" was this). Reuses
   * the pie palette directly: both are "N-way qualitative section" colour needs with the same
   * contrast requirement against the same near-black backgrounds. */
  cScale0: string
  cScale1: string
  cScale2: string
  cScale3: string
  cScale4: string
  cScale5: string
  cScale6: string
  cScale7: string
  /** Section label text colour drawn on top of the `cScale*` fills above; same reasoning as
   * `pieSectionTextColor`. */
  scaleLabelColor: string
}

/** Picker order mirrors `THEMES` (additive: a further dark preset adds a key here too, per
 * research.md decision 1). */
export const MERMAID_THEME_VARIABLES: Record<ThemeId, MermaidThemeVariables> = {
  dark: {
    // `.theme-dark`'s `--background: oklch(0.145 0 0)` == its own `swatch`, `#0a0a0a`.
    background: '#0a0a0a',
    // `--card: oklch(0.205 0 0)` / `--card-foreground: oklch(0.985 0 0)`.
    primaryColor: '#1f1f1f',
    primaryTextColor: '#fafafa',
    // `--border: oklch(0.56 0 0)` == `#747474`, this theme's own opaque border token
    // (quality-gate remediation round 2: `--border` itself moved from 0.5 to 0.56 to also clear
    // 3:1 against `--card`/`--muted`, see globals.css's own comment on `--border`).
    primaryBorderColor: '#747474',
    // `--muted-foreground: oklch(0.708 0 0)`.
    lineColor: '#b5b5b5',
    // `--secondary`/`--muted`: oklch(0.269 0 0); `--accent`: the same value again, so a third
    // distinct fill is picked one step lighter to stay distinguishable from both.
    secondaryColor: '#2b2b2b',
    tertiaryColor: '#3d3d3d',
    // `--foreground: oklch(0.985 0 0)`.
    textColor: '#fafafa',
    darkMode: true,
    // `--muted`/`--secondary: oklch(0.269 0 0)`.
    altSectionBkgColor: '#2b2b2b',
    // `--popover: oklch(0.205 0 0)` / `--popover-foreground: oklch(0.985 0 0)`.
    noteBkgColor: '#1f1f1f',
    noteTextColor: '#fafafa',
    taskTextDarkColor: '#fafafa',
    taskTextClickableColor: '#c7c7c7',
    // Fixed hue-separated palette (measured, not derived from `primaryColor`): blue, green,
    // amber, purple, pink, yellow, cyan, light-red. Each >=8.3:1 against `#0a0a0a`/`#000000` and
    // against `pieSectionTextColor`/`scaleLabelColor` (`#000000`) below.
    pie1: '#76a9ff',
    pie2: '#21df9b',
    pie3: '#ffb734',
    pie4: '#d492ff',
    pie5: '#ff8492',
    pie6: '#ffe066',
    pie7: '#9bf6ff',
    pie8: '#ffadad',
    pieOpacity: 1,
    pieSectionTextColor: '#000000',
    pieStrokeColor: '#747474',
    pieOuterStrokeColor: '#b5b5b5',
    cScale0: '#76a9ff',
    cScale1: '#21df9b',
    cScale2: '#ffb734',
    cScale3: '#d492ff',
    cScale4: '#ff8492',
    cScale5: '#ffe066',
    cScale6: '#9bf6ff',
    cScale7: '#ffadad',
    scaleLabelColor: '#000000'
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
    textColor: '#ffffff',
    darkMode: true,
    altSectionBkgColor: '#242424',
    // `--popover: oklch(0.14 0 0)` / `--popover-foreground: oklch(1 0 0)`.
    noteBkgColor: '#090909',
    noteTextColor: '#ffffff',
    taskTextDarkColor: '#ffffff',
    taskTextClickableColor: '#e0e0e0',
    // Same fixed palette as `dark`: calibrated against a near-black page background, which both
    // themes share, so one palette already clears this theme's higher contrast bar too (measured
    // >=8.89:1 here versus >=8.38:1 under `dark`).
    pie1: '#76a9ff',
    pie2: '#21df9b',
    pie3: '#ffb734',
    pie4: '#d492ff',
    pie5: '#ff8492',
    pie6: '#ffe066',
    pie7: '#9bf6ff',
    pie8: '#ffadad',
    pieOpacity: 1,
    pieSectionTextColor: '#000000',
    pieStrokeColor: '#808080',
    pieOuterStrokeColor: '#cecece',
    cScale0: '#76a9ff',
    cScale1: '#21df9b',
    cScale2: '#ffb734',
    cScale3: '#d492ff',
    cScale4: '#ff8492',
    cScale5: '#ffe066',
    cScale6: '#9bf6ff',
    cScale7: '#ffadad',
    scaleLabelColor: '#000000'
  }
}
