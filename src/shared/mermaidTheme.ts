// Mermaid colour mapping (spec 007 T017, research.md decision 10): each `ThemeDefinition`'s
// own look, translated into a small override layered on top of Mermaid's own built-in `'dark'`
// theme. `Markdown.tsx`'s `MermaidBlock` initializes Mermaid with `theme: 'dark'` (not `'base'`).
//
// Quality-gate remediation (High, round 2): an earlier version of this file used `theme: 'base'`
// (Mermaid's colourless starting point) and hand-built a full `themeVariables` set to patch every
// element Mermaid's `theme-base.js` would otherwise fall back to light-mode colours for. That
// whack-a-mole approach was fixed one diagram type at a time across two review rounds and still
// missed real contrast failures: pie slices and mindmap/timeline section fills derived from a
// dark `primaryColor` collapsed to near-black-on-near-black (measured ~1.1-2.5:1), and Gantt's
// `taskTextDarkColor`/`taskTextClickableColor` (dark text meant to sit on a light task bar, but
// also used for a task's label when it overflows OUTSIDE the bar onto the dark page background)
// measured ~1.4-1.5:1.
//
// Mermaid's own built-in `'dark'` theme (node_modules/mermaid/dist's `theme-dark.js`) already
// derives a reasonable set of colours for most of its surface from `background`/`primaryColor`/
// `textColor` alone -- flowchart, sequence, ER, class diagrams, and Gantt's grid/done/active/crit/
// exclude-range/today-line bands all measured correctly (>=3:1 non-text, >=4.5:1 text) in a real
// mermaid@11.17.2 render with only those overridden. The two families above derive from a dark
// `primaryColor`/from a context-insensitive dark-text constant and stay broken regardless of
// `darkMode`/`theme`, so this file explicitly overrides their specific variables too, verified by
// rendering every diagram type with the real pinned package (scripts/check-mermaid-contrast.mjs).
//
// Quality-gate remediation (High, round 4): round 3's `theme:'dark'` switch was itself re-audited
// against RICHER fixtures (a 12-slot pie, an 11-branch mindmap, a multi-section timeline, a Gantt
// chart with SHORT labels on long done/active/crit bars) than check-mermaid-contrast.mjs's own
// narrow fixtures tested, and two more real gaps surfaced that round 3 missed:
//
// 1. `taskTextDarkColor` was conflated across TWO different Mermaid CSS contexts that happen to
//    share one variable name: Mermaid's `.doneText*`/`.activeText*`/`.doneCritText*`/
//    `.activeCritText*` classes (a task label drawn INSIDE its own light done/active/crit bar --
//    needs a genuinely DARK colour) and `.taskTextOutside*` (the SAME label redrawn OUTSIDE the
//    bar against the dark page background once Mermaid detects overflow -- needs a LIGHT colour,
//    which is what `taskTextDarkColor` was actually set to here). Round 2 only ever tested labels
//    long enough to spill outside their bar, so the INSIDE case (a short label on a long bar, the
//    common case) was never exercised: measured 1.43-2.27:1 for done/active bars. Mermaid exposes
//    a SEPARATE `taskTextOutsideColor` variable for the overflow case (its own
//    `.doneText*.taskTextOutsideRight`/`.doneCritText*.taskTextOutsideRight`-combinator classes
//    win on specificity over the plain `.doneText3` etc.), so the fix is to stop conflating the
//    two: `taskTextDarkColor` is now genuinely dark (pure black measures >=9:1 against both
//    Mermaid's own done (`lightgrey`) and active (`#81B1DB`) bar fills), and `taskTextOutsideColor`
//    takes over the light-text-on-dark-background role. KNOWN RESIDUAL LIMITATION: Mermaid's
//    shipped `gantt/styles.js` only defines that outside-combinator override for `doneText*`/
//    `doneCritText*`, not for `activeText*`/`activeCritText*` -- an active (non-done) task whose
//    label overflows outside a short bar is forced back to `taskTextDarkColor` via `!important`
//    with no theme-variable able to distinguish it from the inside-bar case (the two requirements
//    are provably contradictory for one shared colour: inside needs luminance <=0.053, outside
//    needs >=0.199). This is a real, undiscovered-until-now gap in Mermaid's own CSS, not
//    something this file's theme variables can patch; documented here and in tasks.md rather than
//    silently left for a future round to rediscover. The separate, PLAIN (non-done, non-active)
//    `:crit` task's inside label was measured at 3.06:1 -- but that case is actually governed by
//    `taskTextColor` (no `.critText*` CSS rule exists in Mermaid's shipped `gantt/styles.js`, so
//    the plain `.taskText0`-style rule applies) and `critBkgColor` (the plain crit bar's own
//    fill), not `taskTextDarkColor` at all: fixed below by giving both explicit values instead of
//    leaving them at Mermaid's own defaults (`darkTextColor` text, `#E83737` fill), which cannot
//    jointly clear 4.5:1 -- even pure white only reaches 4.17:1 against Mermaid's default crit
//    red, so `critBkgColor` itself has to move, not just the text colour on top of it.
// 2. The 8-entry `cScale0`-`cScale7`/`pie1`-`pie8` palette only covered 8 of Mermaid's own
//    `THEME_COLOR_LIMIT = 12` slots (round 2's comment claiming 8 was stale -- confirmed from
//    node_modules/mermaid/dist's `theme-dark.js` source itself). Slots 8-11 fell through to
//    Mermaid's own hardcoded near-black defaults (`#154706`, `#161722`, `#00296f`, `#01629c`),
//    measured 1.11-3.23:1 in any pie/mindmap/timeline with more than 8 categories. `cScale11`
//    carries one extra wrinkle verified against Mermaid's real `timeline/styles.js` /
//    `mindmap/styles.ts` source: Mermaid's own `.lineWrapper line` rule (the timeline's main time
//    axis stroke) is regenerated once per colour-scale slot with the SAME selector, so only the
//    LAST slot's `cScaleLabel11` value actually wins the CSS cascade -- and that same value is
//    simultaneously `section-10`'s own label-text colour. `cScale11` is therefore deliberately a
//    muted, moderately-dark tone (unlike the bright `cScale0`-`cScale10`) so one shared colour,
//    `cScaleLabel11`, can be light enough to read as the axis line against the page background
//    AND dark-background-appropriate enough to read as light text on `cScale11`'s own fill.
//    `cScaleInv0`-`cScaleInv11` (the per-section connector-line stroke) default to an algorithmic
//    RGB invert of each `cScale` entry, which inverts a BRIGHT fill into a dark stroke -- measured
//    1.49-2.63:1 against the page background -- so all 12 are now set to an explicit light grey
//    instead of left to invert.
// 3. Journey/gitGraph diagrams' task and section fills (`fillType0`-`fillType7`) are a THIRD,
//    separate "N-way qualitative fill" variable family Mermaid derives from `primaryColor`/
//    `secondaryColor` (near-zero-saturation dark greys in this app's theme, so hue-rotating them
//    for variety does nothing) -- the exact same near-black-on-near-black collapse as the pie/
//    cScale palette before round 2, just never ported to this third family. Journey's own
//    `.label text` colour is hardcoded `#333` in Mermaid's shipped `user-journey/styles.js` with
//    no theme-variable hook at all, so a dark task/section fill made that hardcoded dark label
//    unreadable too (measured ~1.2-1.4:1 both ways). Reusing the bright `cScale0`-`cScale7`
//    palette for `fillType0`-`fillType7` fixes both: the fills read against the page background,
//    and Mermaid's hardcoded dark label text reads against the now-bright fills (>=5.3:1).
// 4. Pie slices were only ever separated by hue (adjacent slices measured as low as 1.00-1.80:1
//    for colour-blind viewers), and `pieStrokeColor` matched `primaryBorderColor` (a mid grey)
//    instead of being genuinely dark, so the separating stroke itself cleared 3:1 against under
//    half the palette. `pieStrokeColor` is now pure black (>=3.3:1 against every slice, most
//    >=8:1), which WCAG 1.4.11 treats as the actual colour-independent slice boundary.
//
// Before building out this round's fixes further, `theme:'dark'` with only `background`/
// `primaryColor`/`primaryTextColor`/`textColor` overridden (the cheapest plausible alternative)
// was re-measured against the SAME richer fixtures: every pie/mindmap colour measured 1.01-3.80:1
// (worse than this file's palette, which already passed pie/mindmap indices 0-7 at >=8.3:1 before
// this round's fix and only needed slots 8-11 filled in) -- `primaryColor` has to stay a dark
// colour to match this app's `--card` token for node fills elsewhere, so Mermaid's own
// `primaryColor`-derived qualitative palettes collapse the same way regardless. Completing this
// file's own fixed palette, rather than reverting to Mermaid's stock derivation, is the net-better
// option; a nicer, more hue-varied high-contrast palette remains later polish (see issue #125).
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
 /** Gantt task-label colour drawn INSIDE a done/active task's own bar (quality-gate remediation,
  * round 4: this key is genuinely DARK now, not light -- see this file's own header comment,
  * point 1. Measures >=9:1 against both of Mermaid's own light done (`lightgrey`) and active
  * (`#81B1DB`) bar fills; does NOT cover a plain crit task's inside label, which uses
  * `taskTextColor` instead -- see that key's own comment). */
 taskTextDarkColor: string
 /** Gantt task-label colour used ONLY when a label overflows outside its task bar onto the page
  * background (quality-gate remediation, round 4: split out of `taskTextDarkColor`, which this
  * file previously (incorrectly) used for both the inside-bar and outside-bar cases -- see this
  * file's own header comment, point 1). Matches `textColor`. KNOWN RESIDUAL LIMITATION: Mermaid's
  * shipped CSS only wires this up for done/doneCrit tasks that overflow, not active/activeCrit --
  * see this file's own header comment, point 1. */
 taskTextOutsideColor: string
 /** Gantt clickable-task label colour; matches the theme's own `--primary`-ish accent so a
  * clickable task reads as interactive against the dark background (quality-gate remediation,
  * round 2: Mermaid's default here, `#003163`, measured ~1.5:1 against this app's background). */
 taskTextClickableColor: string
 /** Gantt's DEFAULT task-label colour (plain tasks, and -- since Mermaid defines no `.critText*`
  * CSS rule -- a plain, non-done, non-active `:crit` task's inside label too; quality-gate
  * remediation, round 4: Mermaid's own default here, an idiosyncratic near-white
  * (`darkTextColor`), measured only 3.07:1 against `critBkgColor` below. Matches `textColor`. */
 taskTextColor: string
 /** Plain (non-done, non-active) crit task bar fill (quality-gate remediation, round 4: Mermaid's
  * own default, `#E83737`, can't jointly clear 4.5:1 against ANY light text -- even pure white
  * only reaches 4.17:1 against it -- while also clearing the 3:1 non-text floor against the page
  * background, so the fill itself has to move, not just `taskTextColor` on top of it). */
 critBkgColor: string
 /** Pie-slice fills, Mermaid's own `THEME_COLOR_LIMIT = 12` slots (quality-gate remediation,
  * round 2: Mermaid derives these from `primaryColor`, which collapses to near-black-on-near-
  * black once `primaryColor` itself is a dark node-fill colour -- measured ~1.1-2.5:1 between
  * adjacent slices and against the page background; round 4: slots 9-12 added -- round 2 only
  * ever filled 8 of Mermaid's 12 slots, see this file's own header comment, point 2). A fixed,
  * hue-separated, high-lightness palette instead: each of `pie1`-`pie12` measures >=8.3:1
  * against both this app's `--card`/`--background` surfaces and the `pieSectionTextColor` label
  * colour below, regardless of which Refract theme is active, so one palette serves every theme.
  * Unlike `cScale11` (which has no choice but to be a muted, moderately-dark tone -- see that
  * key's own comment), `pie12` stays bright like every other slot: Mermaid's pie renderer reads
  * `pie1`-`pie12` as a plain array with no CSS-cascade reuse, so there's no shared-variable
  * conflict here to work around. */
 pie1: string
 pie2: string
 pie3: string
 pie4: string
 pie5: string
 pie6: string
 pie7: string
 pie8: string
 pie9: string
 pie10: string
 pie11: string
 pie12: string
 /** Slice opacity; Mermaid's own default (0.7) blends each slice toward the page background,
  * undoing part of the palette's contrast margin above. Full opacity keeps the measured ratios. */
 pieOpacity: number
 /** Percentage-label text colour, drawn INSIDE each slice; Mermaid's own default here reuses
  * `textColor` (this app's near-white), which is illegible on the light palette above. Black
  * reads at >=8.3:1 against every colour in that palette. */
 pieSectionTextColor: string
 /** Slice border, separating adjacent slices (quality-gate remediation, round 4: previously
  * matched `primaryBorderColor`, a mid grey that cleared 3:1 against under half the palette --
  * pure black clears it against every slice, most >=8:1, and is the colour-independent boundary
  * WCAG 1.4.11 actually wants for a colour-blind viewer who can't rely on hue alone to tell
  * adjacent slices apart). */
 pieStrokeColor: string
 /** Outer ring border; same reasoning as `pieStrokeColor` previously, kept as the lighter
  * `lineColor` since the outer ring has only the page background on its far side, not another
  * slice, so hue-independent separation from a neighbour doesn't apply. */
 pieOuterStrokeColor: string
 /** Mindmap/timeline section fills (`cScale0`-`cScale11`, Mermaid's own `THEME_COLOR_LIMIT`);
  * quality-gate remediation, round 2: same `primaryColor`-derived collapse as the pie palette
  * above (a prior reviewer's report of "node fills pure black on black" was this); round 4:
  * slots 8-11 added, matching the `pie9`-`pie12` comment above. Reuses the pie palette directly
  * for `cScale0`-`cScale10`: both are "N-way qualitative section" colour needs with the same
  * contrast requirement against the same near-black backgrounds. NOTE: this does NOT cover
  * journey's section fills, which are a separate variable family -- see `fillType0`-`fillType7`
  * below. */
 cScale0: string
 cScale1: string
 cScale2: string
 cScale3: string
 cScale4: string
 cScale5: string
 cScale6: string
 cScale7: string
 cScale8: string
 cScale9: string
 cScale10: string
 /** The one deliberate exception to the bright palette above (quality-gate remediation, round
  * 4): Mermaid's real `timeline/styles.js` regenerates its `.lineWrapper line` CSS rule (the
  * timeline's own time-axis stroke) once per colour-scale slot using the SAME selector every
  * time, so only the LAST slot's `cScaleLabel11` value wins the cascade -- and `cScaleLabel11`
  * is simultaneously `section-10`'s own label-text colour, drawn on top of `cScale11`'s fill.
  * One colour can't be both "bright enough to read as a fill against the page background" AND
  * "dark enough to read black text against it, while that same value also reads light enough to
  * be the time-axis stroke" -- so `cScale11` is a muted, moderately-dark tone (still >=3:1
  * against the page background, the WCAG non-text floor) instead of following the rest of the
  * palette, freeing `cScaleLabel11` below to be a light colour that works as both section-10's
  * text (>=4.5:1 against this fill) and the time-axis stroke (>=3:1 against the page
  * background). */
 cScale11: string
 /** Section label text colour drawn on top of the `cScale*` fills above; Mermaid defaults every
  * slot to this single value (`scaleLabelColor`) unless a slot-specific `cScaleLabel<N>` is set,
  * same reasoning as `pieSectionTextColor`. */
 scaleLabelColor: string
 /** The one slot-specific override of `scaleLabelColor` above -- see `cScale11`'s own comment:
  * this single value is simultaneously section-10's label text (needs >=4.5:1 against
  * `cScale11`'s muted fill) and the timeline's time-axis stroke (needs >=3:1 against the page
  * background, since Mermaid's own `.lineWrapper line` rule collapses to whichever slot's
  * `cScaleLabel<N>` was generated last). */
 cScaleLabel11: string
 /** Per-section connector-line stroke (the short underline Mermaid draws beneath each mindmap/
  * timeline node's own label), one per `THEME_COLOR_LIMIT` slot (quality-gate remediation,
  * round 4): Mermaid's own default algorithmically RGB-inverts each `cScale<N>` fill, which
  * inverts this file's BRIGHT fills into dark strokes -- measured 1.49-2.63:1 against the page
  * background. All 12 are set to this app's own `lineColor` instead of left to invert, so the
  * connector line reads regardless of which section it belongs to. */
 cScaleInv0: string
 cScaleInv1: string
 cScaleInv2: string
 cScaleInv3: string
 cScaleInv4: string
 cScaleInv5: string
 cScaleInv6: string
 cScaleInv7: string
 cScaleInv8: string
 cScaleInv9: string
 cScaleInv10: string
 cScaleInv11: string
 /** Journey/gitGraph task and section fills -- a THIRD, separate "N-way qualitative fill"
  * variable family from the `pie`/`cScale` one above (quality-gate remediation, round 4: a
  * round-2/3 comment claiming the `cScale` palette fix above also covered journey's section
  * fills was wrong -- journey never read `cScale*` at all). Mermaid derives these from
  * `primaryColor`/`secondaryColor` by default, the same near-zero-saturation dark greys as the
  * pie palette's own root cause, so they collapsed the same way (measured ~1.2-1.4:1 against
  * the page background) -- AND made journey's own hardcoded-in-Mermaid `.label text { fill:
  * #333 }` (no theme-variable hook exists for this one) unreadable against them too. Reusing
  * the bright `cScale0`-`cScale7` palette fixes both: >=3:1 against the page background, and
  * >=5.3:1 for Mermaid's hardcoded `#333` label text drawn on top. */
 fillType0: string
 fillType1: string
 fillType2: string
 fillType3: string
 fillType4: string
 fillType5: string
 fillType6: string
 fillType7: string
 /** gitGraph commit-dot fills -- a FOURTH, separate "N-way qualitative fill" variable family
  * (quality-gate remediation, round 4): Mermaid derives these by default from `secondaryColor`
  * (lightened by a fixed amount), the same near-zero-saturation dark grey as the `fillType`
  * root cause -- measured 2.54:1 against `--card`. Same bright `cScale0`-`cScale7` palette
  * reused again. */
 git0: string
 git1: string
 git2: string
 git3: string
 git4: string
 git5: string
 git6: string
 git7: string
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
  // Pure black: >=9:1 against both of Mermaid's own done (`lightgrey`) and active (`#81B1DB`)
  // bar fills (round 4). Does NOT need to also clear the plain crit bar (`critBkgColor` below) --
  // a plain `:crit` task's inside label uses `taskTextColor`, not this variable (see this file's
  // own header comment, point 1).
  taskTextDarkColor: '#000000',
  // Matches `textColor`: light text for a label that overflows onto the dark page background.
  taskTextOutsideColor: '#fafafa',
  taskTextClickableColor: '#c7c7c7',
  // Matches `textColor` (round 4): Mermaid's own default here (`darkTextColor`, an idiosyncratic
  // near-white) measured only 3.07:1 against `critBkgColor` below before this file set an
  // explicit value -- see this file's own header comment, point 1.
  taskTextColor: '#fafafa',
  // Round 4: Mermaid's own default (`#E83737`) can't jointly clear 4.5:1 with ANY light text
  // (even pure white only reaches 4.17:1 against it) while also clearing the 3:1 non-text floor
  // against the REAL displayed surface (`--card`, not the app's raw `--background` -- see this
  // file's own header comment, point 2 on measurement surface) -- this value (measured 5.01:1
  // against `taskTextColor` above, 3.15:1 against `--card`) is the plain crit bar's own fill,
  // narrowed to the luminance band that satisfies both at once. See point 1.
  critBkgColor: '#db0000',
  // Fixed hue-separated palette (measured, not derived from `primaryColor`): blue, green,
  // amber, purple, pink, yellow, cyan, light-red, periwinkle, mint, peach, lime. Each >=8.3:1
  // against `--card`/`--background` and against `pieSectionTextColor` (`#000000`) below. Unlike
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
  // against `--card` and 5.12:1 against `cScaleLabel11` below.
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
  // Same bright palette as `cScale0`-`cScale7` -- journey/gitGraph's own separate fill family.
  fillType0: '#76a9ff',
  fillType1: '#21df9b',
  fillType2: '#ffb734',
  fillType3: '#d492ff',
  fillType4: '#ff8492',
  fillType5: '#ffe066',
  fillType6: '#9bf6ff',
  fillType7: '#ffadad',
  // Round 4: gitGraph's own commit-dot fills are a FOURTH separate "N-way qualitative fill"
  // family (`git0`-`git7`), derived by default from `secondaryColor` (near-zero-saturation dark
  // grey) lightened by a fixed amount -- measured 2.54:1 against `--card`, the same collapse
  // pattern as `fillType`/`cScale` before each was fixed. Same bright palette reused again.
  git0: '#76a9ff',
  git1: '#21df9b',
  git2: '#ffb734',
  git3: '#d492ff',
  git4: '#ff8492',
  git5: '#ffe066',
  git6: '#9bf6ff',
  git7: '#ffadad'
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
  // Pure black: >=9:1 against both of Mermaid's own done (`lightgrey`) and active (`#81B1DB`)
  // bar fills (round 4). See `dark`'s own comment on this key.
  taskTextDarkColor: '#000000',
  // Matches `textColor`: light text for a label that overflows onto the dark page background.
  taskTextOutsideColor: '#ffffff',
  taskTextClickableColor: '#e0e0e0',
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
  fillType0: '#76a9ff',
  fillType1: '#21df9b',
  fillType2: '#ffb734',
  fillType3: '#d492ff',
  fillType4: '#ff8492',
  fillType5: '#ffe066',
  fillType6: '#9bf6ff',
  fillType7: '#ffadad',
  git0: '#76a9ff',
  git1: '#21df9b',
  git2: '#ffb734',
  git3: '#d492ff',
  git4: '#ff8492',
  git5: '#ffe066',
  git6: '#9bf6ff',
  git7: '#ffadad'
 }
}
