// Per-theme Mermaid variable data, extracted out of mermaidTheme.ts (issue #551, #806 file-size
// ratchet follow-up: adding the two new `nordic-frost`/`cyber-amber` entries pushed
// mermaidTheme.ts past its own recorded baseline, which is lower-only -- same "pure-data,
// behaviour-preserving move" #564 used for scripts/theme-contrast-pairs.mjs). mermaidTheme.ts
// keeps the `MermaidThemeVariables` interface and `getMermaidThemeCSS`; this file holds only the
// data every theme's own entry supplies, re-exported from mermaidTheme.ts so Markdown.tsx's
// import site is unchanged.

import type { ThemeId } from './themes'
import type { MermaidThemeVariables } from './mermaidTheme'

/** Picker order mirrors `THEMES` (additive: a further dark preset adds a key here too, per
 * research.md decision 1). */
// Quality-gate remediation (code review): `DARK_FAMILY` factors out the palette `dark` and
// `obsidian` share -- the bright pie/cScale/git/fillType qualitative palettes and the task-text
// roles are independent of either theme's own surface tones and were independently verified
// (this file's own rounds 1-6, plus a fresh check against Obsidian's real `--card`
// for this remediation) to clear every floor against BOTH themes' real canvases, not a lazy
// copy-paste that would silently drift. Obsidian's surface-tied fields (background, the
// primary/secondary/tertiary/note roles) are NOT spread from here -- they're overridden below
// with Obsidian's own real tokens, retuned with margin where the shared value fell short.
const DARK_FAMILY: MermaidThemeVariables = {
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
  // Round 5: matches `altSectionBkgColor` -- see this key's own interface comment.
  sectionBkgColor: '#2b2b2b',
  sectionBkgColor2: '#2b2b2b',
  // `--popover: oklch(0.205 0 0)` / `--popover-foreground: oklch(0.985 0 0)`.
  noteBkgColor: '#1f1f1f',
  noteTextColor: '#fafafa',
  // Pure black: >=9:1 against both of Mermaid's own done (`lightgrey`) and active (`#81B1DB`)
  // bar fills (round 4). Does NOT need to also clear the plain crit bar (`critBkgColor` below) --
  // a plain `:crit` task's inside label uses `taskTextColor`, not this variable (see this file's
  // own header comment, point 1).
  taskTextDarkColor: '#000000',
  // Matches `textColor`: light text for a label that overflows onto the dark page background.
  taskTextOutsideColor: '#fafafa',
  // Round 5: matches `textColor`/`taskTextOutsideColor` -- clears >=5:1 against the dark plain/
  // active/crit bars a clickable label can sit on; the done bar (hardcoded `lightgrey`) is
  // handled separately via `getMermaidThemeCSS`'s `themeCSS` override. See this key's own
  // interface comment.
  taskTextClickableColor: '#fafafa',
  // Matches `textColor` (round 4): Mermaid's own default here (`darkTextColor`, an idiosyncratic
  // near-white) measured only 3.07:1 against `critBkgColor` below before this file set an
  // explicit value -- see this file's own header comment, point 1.
  taskTextColor: '#fafafa',
  // Round 4: Mermaid's own default (`#E83737`) can't jointly clear 4.5:1 with ANY light text
  // (even pure white only reaches 4.17:1 against it) while also clearing the 3:1 non-text floor
  // against the REAL displayed surface (`--card`, not the app's raw `--background` -- see this
  // file's own header comment, point 2 on measurement surface) -- this value (measured 5.01:1
  // against `taskTextColor` above, 3.15:1 against `--card`) is the plain crit bar's own fill,
  // narrowed to the luminance band that satisfies both at once. See point 1. Verified for this
  // remediation: also clears 3:1 against Obsidian's own, lighter `--card` (3.14:1).
  critBkgColor: '#db0000',
  // Fixed hue-separated palette (measured, not derived from `primaryColor`): blue, green,
  // amber, purple, pink, yellow, cyan, light-red, periwinkle, mint, peach, lime. Each >=6.98:1
  // against `--card`/`--background` (round 5: corrected from a stale `>=8.3:1` claim here) and
  // >=8.89:1 against `pieSectionTextColor` (`#000000`) below. Unlike
  // `cScale11` (see that key's own comment), `pie12` has no shared-variable conflict -- Mermaid's
  // pie renderer reads `pie1`-`pie12` directly as a plain array (no CSS-cascade reuse), so it
  // stays bright like every other slot instead of needing `cScale11`'s muted compromise.
  pie1: '#76a9ff',
  pie2: '#21df9b',
  pie3: '#ffb734',
  pie4: '#d492ff',
  pie5: '#ff8492',
  pie6: '#ffe066',
  pie7: '#9bf6ff',
  pie8: '#ffadad',
  pie9: '#b3b3ff',
  pie10: '#7affc4',
  pie11: '#ffab73',
  pie12: '#c9ff6b',
  pieOpacity: 1,
  pieSectionTextColor: '#000000',
  pieStrokeColor: '#000000',
  pieOuterStrokeColor: '#b5b5b5',
  cScale0: '#76a9ff',
  cScale1: '#21df9b',
  cScale2: '#ffb734',
  cScale3: '#d492ff',
  cScale4: '#ff8492',
  cScale5: '#ffe066',
  cScale6: '#9bf6ff',
  cScale7: '#ffadad',
  cScale8: '#b3b3ff',
  cScale9: '#7affc4',
  cScale10: '#ffab73',
  // Round 4: re-narrowed against `--card` (not `--background`, see point 2) -- measured 3.09:1
  // against `--card` and 5.12:1 against `cScaleLabel11` below. Verified for this remediation:
  // also clears 3:1 against Obsidian's own, lighter `--card` (3.08:1).
  cScale11: '#a85400',
  scaleLabelColor: '#000000',
  cScaleLabel11: '#fafafa',
  cScaleInv0: '#b5b5b5',
  cScaleInv1: '#b5b5b5',
  cScaleInv2: '#b5b5b5',
  cScaleInv3: '#b5b5b5',
  cScaleInv4: '#b5b5b5',
  cScaleInv5: '#b5b5b5',
  cScaleInv6: '#b5b5b5',
  cScaleInv7: '#b5b5b5',
  cScaleInv8: '#b5b5b5',
  cScaleInv9: '#b5b5b5',
  cScaleInv10: '#b5b5b5',
  cScaleInv11: '#b5b5b5',
  // Round 5: eight distinct, hue-separated MID-TONE colours (see this key's own interface
  // comment) -- journey/gitGraph's own separate fill family, no longer the bright
  // `cScale0`-`cScale7` palette (that put this theme's near-white `textColor` on a light fill).
  // Verified for this remediation: each still clears both >=4.5:1 for `textColor` on top AND
  // >=3:1 against Obsidian's own, lighter `--card` (3.24-3.28:1, narrower than against Dark's
  // own card but still passing; the opposing constraints on this fixed hue-separated set leave
  // no room to widen the margin further without breaking the text-on-fill side -- see the git
  // history for this remediation's own working for the exact trade-off). */
  fillType0: '#2d71b6',
  fillType1: '#247e51',
  fillType2: '#966420',
  fillType3: '#954bcb',
  fillType4: '#ca3359',
  fillType5: '#816d1b',
  fillType6: '#287989',
  fillType7: '#c73e32',
  // Round 4: gitGraph's own commit-dot fills are a FOURTH separate "N-way qualitative fill"
  // family (`git0`-`git7`), derived by default from `secondaryColor` (near-zero-saturation dark
  // grey) lightened by a fixed amount -- measured 2.54:1 against `--card`, the same collapse
  // pattern as `fillType`/`cScale` before each was fixed. Same bright palette reused again
  // (unlike `fillType` above, `git<N>`'s own label text is NOT drawn on top of the fill itself --
  // it sits in a separate pill, coloured by `gitBranchLabel<N>` below -- so `git<N>` stays bright).
  git0: '#76a9ff',
  git1: '#21df9b',
  git2: '#ffb734',
  git3: '#d492ff',
  git4: '#ff8492',
  git5: '#ffe066',
  git6: '#9bf6ff',
  git7: '#ffadad',
  // Round 5 (corroborated by two independent reviewers): Mermaid's shipped `git/styles.js` only
  // defaults this to a theme value when unset -- never set here before, so it fell through to
  // Mermaid's own light-grey default, measured 1.15-1.56:1 against the bright `git0`-`git7`
  // pills above. Pure black clears >=8.89:1 against every one of them. See this key's own
  // interface comment.
  gitBranchLabel0: '#000000',
  gitBranchLabel1: '#000000',
  gitBranchLabel2: '#000000',
  gitBranchLabel3: '#000000',
  gitBranchLabel4: '#000000',
  gitBranchLabel5: '#000000',
  gitBranchLabel6: '#000000',
  gitBranchLabel7: '#000000'
}

export const MERMAID_THEME_VARIABLES: Record<ThemeId, MermaidThemeVariables> = {
  dark: DARK_FAMILY,
  // #550 (theme foundation, palette v2): Obsidian's own real tokens override DARK_FAMILY's
  // surface-tied fields below (globals.css `.theme-obsidian`); the bright qualitative palettes
  // spread from DARK_FAMILY unchanged (verified against THIS canvas/card too, see that const's
  // own comment). `critBkgColor`/`cScale11` needed no change (still clear 3:1 here, 3.14/3.08).
  obsidian: {
    ...DARK_FAMILY,
    // `--background: #0F1014`.
    background: '#0F1014',
    // `--card: #1C1F28` / `--card-foreground: var(--foreground)`.
    primaryColor: '#1C1F28',
    primaryTextColor: '#F8FAFC',
    // `--border: #6F7C9D` (retuned, strong -- see globals.css's own comment on this preset's
    // `--border`).
    primaryBorderColor: '#6F7C9D',
    // `--muted-foreground: #94A3B8`.
    lineColor: '#94A3B8',
    // `--muted`/`--accent`/`--secondary` (`--surface-hover`): `#2A3040`; a third, lighter fill
    // one step up for the same reason DARK_FAMILY's own comment gives.
    secondaryColor: '#2A3040',
    tertiaryColor: '#353D4D',
    // `--foreground: #F8FAFC`.
    textColor: '#F8FAFC',
    altSectionBkgColor: '#2A3040',
    sectionBkgColor: '#2A3040',
    sectionBkgColor2: '#2A3040',
    // `--popover: #242834` / `--popover-foreground: var(--foreground)`.
    noteBkgColor: '#242834',
    noteTextColor: '#F8FAFC',
    taskTextOutsideColor: '#F8FAFC',
    taskTextClickableColor: '#F8FAFC',
    taskTextColor: '#F8FAFC',
    // `.theme-dark-high-contrast`'s own entry below overrides these same two key families to its own
    // muted-foreground rather than leaving DARK_FAMILY's neutral `#b5b5b5` grey; matching that
    // pattern here too, to this preset's own `--muted-foreground` (`#94A3B8`, same value as
    // `lineColor` above), rather than a neutral grey unrelated to its own palette.
    pieOuterStrokeColor: '#94A3B8',
    cScaleInv0: '#94A3B8',
    cScaleInv1: '#94A3B8',
    cScaleInv2: '#94A3B8',
    cScaleInv3: '#94A3B8',
    cScaleInv4: '#94A3B8',
    cScaleInv5: '#94A3B8',
    cScaleInv6: '#94A3B8',
    cScaleInv7: '#94A3B8',
    cScaleInv8: '#94A3B8',
    cScaleInv9: '#94A3B8',
    cScaleInv10: '#94A3B8',
    cScaleInv11: '#94A3B8',
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
    // Round 5: matches `altSectionBkgColor` -- see this key's own interface comment.
    sectionBkgColor: '#242424',
    sectionBkgColor2: '#242424',
    // `--popover: oklch(0.14 0 0)` / `--popover-foreground: oklch(1 0 0)`.
    noteBkgColor: '#090909',
    noteTextColor: '#ffffff',
    // Pure black: >=9:1 against both of Mermaid's own done (`lightgrey`) and active (`#81B1DB`)
    // bar fills (round 4). See `dark`'s own comment on this key.
    taskTextDarkColor: '#000000',
    // Matches `textColor`: light text for a label that overflows onto the dark page background.
    taskTextOutsideColor: '#ffffff',
    // Round 5: same reasoning as `dark`'s own comment on this key. Matches `textColor`.
    taskTextClickableColor: '#ffffff',
    // Matches `textColor` (round 4). See `dark`'s own comment on this key.
    taskTextColor: '#ffffff',
    // Same value as `dark` (round 4): measured 5.23:1 against `taskTextColor` above and 3.80:1
    // against `--card` under this theme's own (darker) `--card`. See `dark`'s own comment.
    critBkgColor: '#db0000',
    // Same fixed palette as `dark`: calibrated against a near-black `--card`/`--background`, which
    // both themes share (this theme's own `--card`, `#090909`, is darker still than `dark`'s, so
    // every slot clears this theme's higher contrast bar too). `cScale11` is the one deliberate
    // exception -- see its own interface comment; `pie12` is NOT (it stays bright, same comment).
    pie1: '#76a9ff',
    pie2: '#21df9b',
    pie3: '#ffb734',
    pie4: '#d492ff',
    pie5: '#ff8492',
    pie6: '#ffe066',
    pie7: '#9bf6ff',
    pie8: '#ffadad',
    pie9: '#b3b3ff',
    pie10: '#7affc4',
    pie11: '#ffab73',
    pie12: '#c9ff6b',
    pieOpacity: 1,
    pieSectionTextColor: '#000000',
    pieStrokeColor: '#000000',
    pieOuterStrokeColor: '#cecece',
    cScale0: '#76a9ff',
    cScale1: '#21df9b',
    cScale2: '#ffb734',
    cScale3: '#d492ff',
    cScale4: '#ff8492',
    cScale5: '#ffe066',
    cScale6: '#9bf6ff',
    cScale7: '#ffadad',
    cScale8: '#b3b3ff',
    cScale9: '#7affc4',
    cScale10: '#ffab73',
    // Round 4: re-narrowed against `--card` -- measured 3.73:1 against `--card` and 5.34:1 against
    // `cScaleLabel11` below. See `dark`'s own comment on this key.
    cScale11: '#a85400',
    scaleLabelColor: '#000000',
    cScaleLabel11: '#ffffff',
    cScaleInv0: '#cecece',
    cScaleInv1: '#cecece',
    cScaleInv2: '#cecece',
    cScaleInv3: '#cecece',
    cScaleInv4: '#cecece',
    cScaleInv5: '#cecece',
    cScaleInv6: '#cecece',
    cScaleInv7: '#cecece',
    cScaleInv8: '#cecece',
    cScaleInv9: '#cecece',
    cScaleInv10: '#cecece',
    cScaleInv11: '#cecece',
    // Round 5: same eight mid-tone colours as `dark` -- see that theme's own comment on this key
    // and the `fillType0`-`fillType7` interface comment (the shared luminance window clears both
    // themes' constraints at once).
    fillType0: '#2d71b6',
    fillType1: '#247e51',
    fillType2: '#966420',
    fillType3: '#954bcb',
    fillType4: '#ca3359',
    fillType5: '#816d1b',
    fillType6: '#287989',
    fillType7: '#c73e32',
    // Same bright palette as `dark` -- see that theme's own comment on this key.
    git0: '#76a9ff',
    git1: '#21df9b',
    git2: '#ffb734',
    git3: '#d492ff',
    git4: '#ff8492',
    git5: '#ffe066',
    git6: '#9bf6ff',
    git7: '#ffadad',
    // Round 5: same reasoning as `dark`'s own comment on this key.
    gitBranchLabel0: '#000000',
    gitBranchLabel1: '#000000',
    gitBranchLabel2: '#000000',
    gitBranchLabel3: '#000000',
    gitBranchLabel4: '#000000',
    gitBranchLabel5: '#000000',
    gitBranchLabel6: '#000000',
    gitBranchLabel7: '#000000'
  },
  // #551 (Nordic Frost / Cyber Amber dark presets): same pattern #550 used for Obsidian --
  // DARK_FAMILY's bright, hue-separated qualitative palettes spread unchanged. Verified for
  // this story (gate round 1, not merely assumed from DARK_FAMILY's own Dark/Obsidian-specific
  // comment): the two narrowest-margin values, `critBkgColor`/`cScale11`, clear 3:1 against both
  // new presets' own `--card` (critBkgColor 3.31/3.37, cScale11 3.24/3.31 for Nordic
  // Frost/Cyber Amber respectively), with `textColor`-on-`critBkgColor` and
  // `cScaleLabel11`-on-`cScale11` both clearing 4.5:1+; only the surface-tied fields are
  // overridden with each preset's own real globals.css tokens. Live Mermaid-render verification
  // (`check:mermaid-contrast`, a real-Chromium check) is deferred to this lane's build slot,
  // same as every other check requiring a live renderer.
  'nordic-frost': {
    ...DARK_FAMILY,
    background: '#060f1e', // `--background`
    primaryColor: '#101b2b', // `--card`
    primaryTextColor: '#eff7fb', // `--card-foreground`/`--foreground`
    primaryBorderColor: '#79818c', // `--border`
    lineColor: '#92a1a9', // `--muted-foreground`
    secondaryColor: '#293342', // `--muted`/`--accent`/`--secondary` (`--surface-hover`)
    tertiaryColor: '#34404F', // one step lighter, same reasoning as DARK_FAMILY's own comment
    textColor: '#eff7fb',
    altSectionBkgColor: '#293342',
    sectionBkgColor: '#293342',
    sectionBkgColor2: '#293342',
    noteBkgColor: '#1c2738', // `--popover`
    noteTextColor: '#eff7fb',
    taskTextOutsideColor: '#eff7fb',
    taskTextClickableColor: '#eff7fb',
    taskTextColor: '#eff7fb',
    // Same pattern as Obsidian's own entry: this preset's own `--muted-foreground`.
    pieOuterStrokeColor: '#92a1a9',
    cScaleInv0: '#92a1a9',
    cScaleInv1: '#92a1a9',
    cScaleInv2: '#92a1a9',
    cScaleInv3: '#92a1a9',
    cScaleInv4: '#92a1a9',
    cScaleInv5: '#92a1a9',
    cScaleInv6: '#92a1a9',
    cScaleInv7: '#92a1a9',
    cScaleInv8: '#92a1a9',
    cScaleInv9: '#92a1a9',
    cScaleInv10: '#92a1a9',
    cScaleInv11: '#92a1a9'
  },
  'cyber-amber': {
    ...DARK_FAMILY,
    background: '#0f0703', // `--background`
    primaryColor: '#22160e', // `--card`
    primaryTextColor: '#faf4ef', // `--card-foreground`/`--foreground`
    primaryBorderColor: '#887e78', // `--border`
    lineColor: '#bb9679', // `--muted-foreground` (retuned, gate round 1)
    secondaryColor: '#382e28', // `--muted`/`--accent`/`--secondary` (`--surface-hover`, retuned)
    tertiaryColor: '#453b34', // one step lighter, same reasoning as DARK_FAMILY's own comment
    textColor: '#faf4ef',
    altSectionBkgColor: '#382e28',
    sectionBkgColor: '#382e28',
    sectionBkgColor2: '#382e28',
    noteBkgColor: '#2c221b', // `--popover` (retuned)
    noteTextColor: '#faf4ef',
    taskTextOutsideColor: '#faf4ef',
    taskTextClickableColor: '#faf4ef',
    taskTextColor: '#faf4ef',
    pieOuterStrokeColor: '#bb9679',
    cScaleInv0: '#bb9679',
    cScaleInv1: '#bb9679',
    cScaleInv2: '#bb9679',
    cScaleInv3: '#bb9679',
    cScaleInv4: '#bb9679',
    cScaleInv5: '#bb9679',
    cScaleInv6: '#bb9679',
    cScaleInv7: '#bb9679',
    cScaleInv8: '#bb9679',
    cScaleInv9: '#bb9679',
    cScaleInv10: '#bb9679',
    cScaleInv11: '#bb9679'
  }
}
