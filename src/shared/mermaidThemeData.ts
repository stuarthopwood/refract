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
  // `--card: oklch(0.205 0 0)`. Gate-fix (#1074 round 1, Code/Test HIGH): white at 90% alpha
  // composited over `--card` gives 14.59:1. Round 3 correction: Mermaid's bundled 'dark' base
  // theme hardcodes its REAL node fill (`mainBkg`/`nodeBkg`) to a literal `#1f2020`, ignoring
  // our own `primaryColor` override entirely (`node_modules/mermaid/.../theme-dark.js`'s own
  // constructor; we never pass a `mainBkg` override, so it never falls back to `primaryColor`)
  // -- the REAL composited ratio here is 13.33:1 against that literal, still >>4.5:1.
  primaryColor: '#1f1f1f',
  primaryTextColor: '#e8e8e8',
  // Gate round 3 fix (Main, #1074 follow-up): FR-023's 0.9 tier, same formula as
  // `primaryTextColor` above (white at 90% alpha composited over `--card`) -- byte-identical
  // value, since both use the exact same methodology. Previously unset, so every preset fell
  // through to Mermaid's own hardcoded `#F9FFFE` regardless of its own palette (interface
  // comment has the full citation).
  titleColor: '#e8e8e8',
  // `--border: oklch(0.56 0 0)` == `#747474`, this theme's own opaque border token
  // (quality-gate remediation round 2: `--border` itself moved from 0.5 to 0.56 to also clear
  // 3:1 against `--card`/`--muted`, see globals.css's own comment on `--border`).
  primaryBorderColor: '#747474',
  // `--muted-foreground: oklch(1 0 0 / 60%)` (#1074). This line/stroke colour sits on the
  // diagram's own page background (`background` below, `oklch(0.145 0 0)`): FR-023's 0.6 tier,
  // white at 60% alpha composited over it -- 7.30:1. `pieOuterStrokeColor`/`cScaleInv0`-`11`
  // below are the SAME muted line/stroke role on the same backdrop and carry the identical value.
  lineColor: '#9d9d9d',
  // `--secondary`/`--muted`: oklch(0.269 0 0); `--accent`: the same value again, so a third
  // distinct fill is picked one step lighter to stay distinguishable from both.
  secondaryColor: '#2b2b2b',
  tertiaryColor: '#3d3d3d',
  // `--foreground: oklch(1 0 0 / 90%)` (#1074: app-wide text-opacity softening). General
  // diagram text (titles, edge labels) sits on the page background: white at 90% alpha
  // composited over `background` (`oklch(0.145 0 0)`) -- 15.93:1. `taskTextOutsideColor` below
  // is the SAME role (its own comment: "a label that overflows onto the dark page background")
  // and carries the identical value.
  textColor: '#e7e7e7',
  darkMode: true,
  // `--muted`/`--secondary: oklch(0.269 0 0)`.
  altSectionBkgColor: '#2b2b2b',
  // Round 5: matches `altSectionBkgColor` -- see this key's own interface comment.
  sectionBkgColor: '#2b2b2b',
  sectionBkgColor2: '#2b2b2b',
  // `--popover: oklch(0.205 0 0)` / `--popover-foreground`. Gate-fix (#1074 round 1): note text
  // sits on `noteBkgColor` (this theme's own note fill, tied to `--popover`) -- FR-023's 0.78
  // tier, white at 78% alpha composited over `--popover` (`oklch(0.205 0 0)`) -- 11.15:1.
  noteBkgColor: '#1f1f1f',
  noteTextColor: '#cccccc',
  // Pure black: >=9:1 against both of Mermaid's own done (`lightgrey`) and active (`#81B1DB`)
  // bar fills (round 4). Does NOT need to also clear the plain crit bar (`critBkgColor` below) --
  // a plain `:crit` task's inside label uses `taskTextColor`, not this variable (see this file's
  // own header comment, point 1).
  taskTextDarkColor: '#000000',
  // Matches `textColor` (#1074): this IS the "page background" role (not a task-bar fill), see
  // this key's own original comment -- light text for a label that overflows onto the dark page
  // background.
  taskTextOutsideColor: '#e7e7e7',
  // Gate-fix (#1074 round 1, Code/Test HIGH): deliberately NOT softened, unlike every other
  // `taskText*`/`textColor` role above -- this label sits on a real COLOURED, non-neutral task-
  // bar fill (plain/active/`critBkgColor`, per this key's own "clears >=5:1 against the dark
  // plain/active/crit bars" comment below), the same "foreground on a coloured fill stays solid"
  // rule FR-023 already applies to `--send-foreground`/`--destructive-foreground` elsewhere.
  // Softening it to the 0.9 tier measured only 4.23:1 against `critBkgColor` (below the 4.5:1
  // floor this key's own comment requires) and far worse against the lighter plain/active bars
  // -- stays the theme's old solid literal.
  // Round 5: matches `textColor`/`taskTextOutsideColor` -- clears >=5:1 against the dark plain/
  // active/crit bars a clickable label can sit on; the done bar (hardcoded `lightgrey`) is
  // handled separately via `getMermaidThemeCSS`'s `themeCSS` override. See this key's own
  // interface comment.
  taskTextClickableColor: '#fafafa',
  // Gate-fix (#1074 round 1): same coloured-fill exception as `taskTextClickableColor` above --
  // this is the plain crit bar's OWN inside label (see `critBkgColor`'s own comment just below:
  // "measured 5.01:1 against `taskTextColor` above"), a real non-neutral fill, so it stays solid.
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
  pieOuterStrokeColor: '#9d9d9d',
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
  cScaleInv0: '#9d9d9d',
  cScaleInv1: '#9d9d9d',
  cScaleInv2: '#9d9d9d',
  cScaleInv3: '#9d9d9d',
  cScaleInv4: '#9d9d9d',
  cScaleInv5: '#9d9d9d',
  cScaleInv6: '#9d9d9d',
  cScaleInv7: '#9d9d9d',
  cScaleInv8: '#9d9d9d',
  cScaleInv9: '#9d9d9d',
  cScaleInv10: '#9d9d9d',
  cScaleInv11: '#9d9d9d',
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
    // `--card: #1C1F28`. Gate-fix (#1074 round 1, Code/Test HIGH): white at 90% alpha
    // composited over `--card` (`#1C1F28`) gives 13.51:1. Round 3 correction: the REAL node
    // fill Mermaid renders is its own hardcoded `#1f2020` literal, not `--card` (see
    // `DARK_FAMILY`'s own comment on this key for the full citation) -- real ratio 13.43:1.
    primaryColor: '#1C1F28',
    primaryTextColor: '#e8e9e9',
    // Gate round 3 fix (Main, #1074 follow-up): FR-023's 0.9 tier, same formula/value as
    // `primaryTextColor` above (see `DARK_FAMILY`'s own comment for the full citation).
    titleColor: '#e8e9e9',
    // `--border: #6F7C9D` (retuned, strong -- see globals.css's own comment on this preset's
    // `--border`).
    primaryBorderColor: '#6F7C9D',
    // `--muted-foreground: oklch(1 0 0 / 60%)` (#1074). Line/stroke on the page background --
    // FR-023's 0.6 tier, white at 60% alpha composited over `--background` (`#0F1014`) --
    // 7.22:1. `pieOuterStrokeColor`/`cScaleInv0`-`11` below carry the identical value.
    lineColor: '#9f9fa1',
    // `--muted`/`--accent`/`--secondary` (`--surface-hover`): `#2A3040`; a third, lighter fill
    // one step up for the same reason DARK_FAMILY's own comment gives.
    secondaryColor: '#2A3040',
    tertiaryColor: '#353D4D',
    // `--foreground: oklch(1 0 0 / 90%)` (#1074). General diagram text on the page background --
    // FR-023's 0.9 tier, white at 90% alpha composited over `--background` (`#0F1014`) --
    // 15.39:1. `taskTextOutsideColor` below is the same role and carries the identical value.
    textColor: '#e7e7e7',
    altSectionBkgColor: '#2A3040',
    sectionBkgColor: '#2A3040',
    sectionBkgColor2: '#2A3040',
    // `--popover: #242834`. Gate-fix (#1074 round 1): note text on this fill -- FR-023's 0.78
    // tier, white at 78% alpha composited over `--popover` (`#242834`) -- 9.51:1.
    noteBkgColor: '#242834',
    noteTextColor: '#cfd0d2',
    // Matches `textColor` (#1074): the page-background role, same as `DARK_FAMILY`'s own comment
    // on this key.
    taskTextOutsideColor: '#e7e7e7',
    // Gate-fix (#1074 round 1): deliberately NOT softened -- sits on a real coloured task-bar
    // fill (plain/active/`critBkgColor`), same "stays solid on a coloured fill" exception
    // `DARK_FAMILY`'s own comment on this key explains in full.
    taskTextClickableColor: '#F8FAFC',
    // Gate-fix (#1074 round 1): same coloured-fill exception as `taskTextClickableColor` above.
    taskTextColor: '#F8FAFC',
    // `.theme-dark-high-contrast`'s own entry below overrides these same two key families to its own
    // muted-foreground rather than leaving DARK_FAMILY's neutral `#9d9d9d` grey; matching that
    // pattern here too, to this preset's own softened `--muted-foreground` (same `lineColor`
    // value above), rather than a neutral grey unrelated to its own palette.
    pieOuterStrokeColor: '#9f9fa1',
    cScaleInv0: '#9f9fa1',
    cScaleInv1: '#9f9fa1',
    cScaleInv2: '#9f9fa1',
    cScaleInv3: '#9f9fa1',
    cScaleInv4: '#9f9fa1',
    cScaleInv5: '#9f9fa1',
    cScaleInv6: '#9f9fa1',
    cScaleInv7: '#9f9fa1',
    cScaleInv8: '#9f9fa1',
    cScaleInv9: '#9f9fa1',
    cScaleInv10: '#9f9fa1',
    cScaleInv11: '#9f9fa1',
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
    // Gate round 3 fix (Main, #1074 follow-up): stays solid, unaffected by #1074 (FR-023), same
    // as `primaryTextColor` above.
    titleColor: '#ffffff',
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
  // Frost/Cyber Amber respectively), with `taskTextColor`-on-`critBkgColor` (deliberately NOT
  // softened by #1074, see that key's own comment) and `cScaleLabel11`-on-`cScale11` both
  // clearing 4.5:1+; only the surface-tied fields are overridden with each preset's own real
  // globals.css tokens. Live Mermaid-render verification (`check:mermaid-contrast`) is blocked,
  // not merely deferred -- that script calls `require('electron')` directly, which the CDP/Tauri
  // live-verify harness every other check in this story uses does not provide (issue #1106,
  // filed round 3: port to the CDP/Tauri harness or pure `contrast-math.mjs`). Separately
  // (issue #1108, filed round 3, amended round 3): every Gantt task-text token in this file
  // (`taskTextOutsideColor`/`taskTextClickableColor`/`critBkgColor`/`sectionBkgColor`-family,
  // INCLUDING `taskTextColor`'s own Gantt role) is still measured by `contrast-math.mjs`
  // arithmetic against Mermaid's own documented CSS template strings only, not a real rendered
  // Gantt diagram -- #1108's scope stays Gantt-only. `taskTextColor` IS separately
  // live-verified for Journey specifically (this round, `997-notice-severity.jsonl`'s extended
  // fence): Gantt uses it as an SVG `fill` (Mermaid's own `.taskText { fill: taskTextColor }`
  // rule, a rendered `<text>`/`<tspan>`), while Journey uses the round-3 CSS override's
  // `color` property on an HTML foreignObject `<div class="label">` (`mermaidTheme.ts`'s own
  // comment on that fix) -- two different properties on two different element types, NOT "the
  // identical renderer/CSS-class path" this comment previously (wrongly) claimed. Gantt's own
  // use of `taskTextColor` remains unverified, still under #1108.
  'nordic-frost': {
    ...DARK_FAMILY,
    background: '#060f1e', // `--background`
    primaryColor: '#101b2b', // `--card`
    // Gate-fix (#1074 round 1, Code/Test HIGH): FR-023's 0.9 tier, white at 90% alpha
    // composited over `--card` (`#101b2b`) gives 14.13:1. Round 3 correction: the REAL node
    // fill Mermaid renders is its own hardcoded `#1f2020` literal, not `--card` (see
    // `DARK_FAMILY`'s own comment on this key for the full citation) -- real ratio 13.32:1.
    primaryTextColor: '#e7e8ea',
    // Gate round 3 fix (Main, #1074 follow-up): FR-023's 0.9 tier, same formula/value as
    // `primaryTextColor` above (see `DARK_FAMILY`'s own comment for the full citation).
    titleColor: '#e7e8ea',
    primaryBorderColor: '#79818c', // `--border`
    // Gate-fix (#1074 round 1): FR-023's 0.6 tier, white at 60% alpha composited over
    // `--background` (`#060f1e`) -- 7.22:1. `pieOuterStrokeColor`/`cScaleInv0`-`11` below carry
    // the identical value.
    lineColor: '#9b9fa5',
    secondaryColor: '#293342', // `--muted`/`--accent`/`--secondary` (`--surface-hover`)
    tertiaryColor: '#34404F', // one step lighter, same reasoning as DARK_FAMILY's own comment
    // Gate-fix (#1074 round 1): FR-023's 0.9 tier, white at 90% alpha composited over
    // `--background` (`#060f1e`) -- 15.50:1. `taskTextOutsideColor` below carries the same value.
    textColor: '#e6e7e8',
    altSectionBkgColor: '#293342',
    sectionBkgColor: '#293342',
    sectionBkgColor2: '#293342',
    noteBkgColor: '#1c2738', // `--popover`
    // Gate-fix (#1074 round 1): FR-023's 0.78 tier, white at 78% alpha composited over
    // `--popover` (`#1c2738`) -- 9.67:1.
    noteTextColor: '#cdcfd3',
    // Matches `textColor` (#1074): the page-background role, same as `DARK_FAMILY`'s own comment
    // on this key.
    taskTextOutsideColor: '#e6e7e8',
    // Gate-fix (#1074 round 1): deliberately NOT softened -- sits on a real coloured task-bar
    // fill (plain/active/`critBkgColor`), same "stays solid on a coloured fill" exception
    // `DARK_FAMILY`'s own comment on this key explains in full.
    taskTextClickableColor: '#eff7fb',
    // Gate-fix (#1074 round 1): same coloured-fill exception as `taskTextClickableColor` above.
    taskTextColor: '#eff7fb',
    // Same pattern as Obsidian's own entry: this preset's own softened `--muted-foreground`
    // (#1074, same `lineColor` value above).
    pieOuterStrokeColor: '#9b9fa5',
    cScaleInv0: '#9b9fa5',
    cScaleInv1: '#9b9fa5',
    cScaleInv2: '#9b9fa5',
    cScaleInv3: '#9b9fa5',
    cScaleInv4: '#9b9fa5',
    cScaleInv5: '#9b9fa5',
    cScaleInv6: '#9b9fa5',
    cScaleInv7: '#9b9fa5',
    cScaleInv8: '#9b9fa5',
    cScaleInv9: '#9b9fa5',
    cScaleInv10: '#9b9fa5',
    cScaleInv11: '#9b9fa5'
  },
  // #1039 gate round 1 fix (Code/Test HIGH): Cyber Amber's own surfaces, text and border are now
  // byte-identical to Default Dark's (globals.css's own `.theme-cyber-amber` header comment),
  // so its Mermaid palette reuses `DARK_FAMILY` directly -- the SAME object Dark itself uses,
  // not a per-field copy that could silently drift. The brown literals this entry used to
  // override (`#0f0703`/`#22160e`/`#faf4ef`/`#887e78`/`#bb9679`/`#382e28`/`#2c221b`) predate
  // #1039's retune and are gone; only the accent family (`--accent-text`, `--primary`/`--send`),
  // the warning hue, `--severity-error`/`--pr-closed` (hue 22, retuned for the accent-vs-error
  // distinctness floor), and `themes.ts`'s own `swatchPrimary` still differ from Dark, none of
  // which Mermaid's own `themeVariables` read. Live-verified (`scripts/verify-1039-amber-
  // retune.mjs`, round-2 gate fix): a real rendered Mermaid flowchart's own SVG (decoded from
  // its `data:image/svg+xml` `<img>` source) is byte-for-byte identical to Dark's own render,
  // after normalising the per-mount id both sides share --
  // Mermaid derives its node FILL internally (never the raw `primaryColor` literal verbatim),
  // so this is a full-string equality check, not a hardcoded-literal match; `taskTextColor`
  // (`#fafafa`, deliberately NOT softened by #1074) IS a literal match, confirmed separately.
  'cyber-amber': DARK_FAMILY
}
