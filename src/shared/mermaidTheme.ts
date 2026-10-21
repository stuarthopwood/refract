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
//    needs >=0.199). Round 4 documented this as an undiscovered, unpatchable gap in Mermaid's own
//    CSS -- that was correct about theme VARIABLES (one variable genuinely cannot satisfy both
//    requirements at once) but incomplete: round 5 fixes it anyway, via Mermaid's documented
//    `themeCSS` init option (`mermaid.initialize({ ..., themeCSS })`, see `getMermaidThemeCSS`
//    below), which injects an ADDITIONAL CSS rule rather than substituting a variable. A
//    two-class selector Mermaid's own shipped CSS never defines for these states
//    (`.activeText<N>.taskTextOutsideLeft`/`Right`, `.activeCritText<N>.taskTextOutsideLeft`/
//    `Right`) beats the single-class `!important` rule on specificity alone (two classes beat
//    one, regardless of source order, since both are `!important`) -- verified in a real render:
//    measured 8.89-19.25:1 afterward, see `getMermaidThemeCSS`'s own comment. The separate,
//    PLAIN (non-done, non-active)
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
//    cScale palette before round 2, just never ported to this third family. Round 4 fixed this by
//    reusing the bright `cScale0`-`cScale7` palette here too, on the assumption that Journey's
//    task/section label text is an SVG `<text>` element matching Mermaid's shipped
//    `user-journey/styles.js` rule `.label text { fill: #333 }` (hardcoded, no theme-variable
//    hook) -- so a BRIGHT fill would read against that hardcoded DARK label. That assumption was
//    wrong (round 5, corroborated by two independent reviewers measuring the real rendered DOM):
//    Journey draws its task/section labels as a plain `<div class="label">` inside a
//    `<foreignObject>` (Mermaid's own `_drawTextCandidateFunc`'s `fo`/`byHtml` path, the default
//    when `htmlLabels` is not explicitly disabled), never an SVG `<text>` -- so the
//    `.label text { fill: #333 }` rule, which only matches an actual `<text>` descendant, never
//    applies to it at all. The div is instead styled by Mermaid's OTHER `.label { color: textColor
//    }` rule, i.e. this app's own near-white `textColor` -- LIGHT text. Round 4's bright fill
//    therefore put light text on a light-to-bright fill (measured 1.18-2.36:1, a NEW regression
//    that round). Round 5 fix: `fillType0`-`fillType7` are now eight distinct, hue-separated
//    MID-TONE colours (same technique already used for `cScale11` above -- narrowed to the
//    luminance band that clears BOTH constraints at once: dark enough for `textColor` to read at
//    >=4.5:1 on top, luminance <=0.173/0.183 (dark/`dark-high-contrast`), AND light enough to
//    still clear the pre-existing >=3:1 floor against `--card`, luminance >=0.141/0.108), not the
//    bright `cScale0`-`cScale7` values (measured: all eight slots clear >=4.8:1 against
//    `textColor` and >=3.2:1 against `--card` in both themes).
// 4. Pie slices were only ever separated by hue (adjacent slices measured as low as 1.00-1.80:1
//    for colour-blind viewers), and `pieStrokeColor` matched `primaryBorderColor` (a mid grey)
//    instead of being genuinely dark, so the separating stroke itself cleared 3:1 against under
//    half the palette. `pieStrokeColor` is now pure black (>=3.3:1 against every slice, most
//    >=8:1), which WCAG 1.4.11 treats as the actual colour-independent slice boundary.
//
// Before building out this round's fixes further, `theme:'dark'` with only `background`/
// `primaryColor`/`primaryTextColor`/`textColor` overridden (the cheapest plausible alternative)
// was re-measured against the SAME richer fixtures: every pie/mindmap colour measured 1.01-3.80:1
// (worse than this file's palette, which already passed pie/mindmap indices 0-7 at >=6.98:1 before
// this round's fix and only needed slots 8-11 filled in) -- `primaryColor` has to stay a dark
// colour to match this app's `--card` token for node fills elsewhere, so Mermaid's own
// `primaryColor`-derived qualitative palettes collapse the same way regardless. Completing this
// file's own fixed palette, rather than reverting to Mermaid's stock derivation, is the net-better
// option; a nicer, more hue-varied high-contrast palette remains later polish (see issue #125).
//
// Quality-gate remediation (round 5): round 4 shipped with scripts/check-mermaid-contrast.mjs
// reporting 182/182 PASS; two independent reviewers (code-reviewer, accessibility-auditor) each
// built their OWN from-scratch measurement harness (real computed style + `elementsFromPoint`
// hit-testing against the actual rendered DOM, not that script's own regex-over-serialized-CSS-
// text approach, which can only read a rule's declared value, never ask which rule actually WINS
// the cascade for a given element or what shape is actually underneath a piece of text) and
// independently converged on the same 3 real failures that script could not see:
// 1. Gantt active/activeCrit overflow labels (1.05-2.26:1) -- see this file's header comment,
//    point 1, and `getMermaidThemeCSS`'s own comment.
// 2. gitGraph branch-name labels (1.15-1.56:1) -- see `gitBranchLabel0`-`gitBranchLabel7`'s own
//    interface comment.
// 3. Journey task/section labels (1.18-2.36:1, a NEW regression this round) -- see
//    `fillType0`-`fillType7`'s own interface comment.
// Plus two Medium-severity gaps fixed in the same pass: Timeline section-10 (`cScale11`'s own
// comment) and Gantt clickable-task labels against the done bar (`taskTextClickableColor`'s own
// comment). scripts/check-mermaid-contrast.mjs itself was rewritten to match the reviewers'
// methodology (computed style + `elementsFromPoint`, with the actually-rendered leaf text/shape
// as the unit of measurement, not a diagram-type-specific regex over the `<style>` block text) --
// see that script's own header comment for the full rationale.
//
// Quality-gate remediation (round 6): shipping commit 0c7e1e1 (round 5) was re-audited again by
// two independent reviewers, each building their OWN from-scratch screenshot-PIXEL-diff harness
// (render once with text visible, once with every glyph hidden, diff the two real screenshots to
// find each glyph's actual painted pixels) rather than trusting computed style + `elementsFromPoint`
// as round 5's own reviewers and check-mermaid-contrast.mjs did -- and found 2 more real failures
// that methodology could not see, plus a real gap in round 5's own replacement checker:
// 1. Gantt clickable-task labels against the ACTIVE/activeCrit bars (round 5 only ever covered the
//    done bar) -- see `taskTextClickableColor`'s own interface comment and `getMermaidThemeCSS`'s
//    own comment.
// 2. gitGraph commit-id labels (1.73-2.87:1, pre-existing, not introduced by round 5) -- see
//    `getMermaidThemeCSS`'s own comment on `.commit-label-bkg`.
// 3. scripts/mermaid-contrast-measure.mjs's `elementsFromPoint`-based background resolution only
//    ever composited a hit-tested element's `fill`/`background-color`, never a painted STROKE (a
//    `<path>` with `fill:none` but a visible `stroke`, or a bare `<line>`) -- a label sitting over
//    a stroked line was treated as if nothing were painted there, which is exactly how finding 2
//    above passed round 5's own checker at a reported 7.59:1. Round 6 replaces TEXT background/
//    foreground resolution with the screenshot-pixel-diff technique both reviewers' own harnesses
//    used (shape/pie checks are unaffected and keep the round-5 `elementsFromPoint` approach --
//    see that file's own header comment for the full rationale and the one documented limitation
//    the bucketed-by-background diffing itself has).
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
  * theme's own `--muted`/`--secondary`. Covers ONLY Gantt's ODD section rows (Mermaid's shipped
  * `gantt/styles.js` rule `.section1, .section3 { fill: altSectionBkgColor }`) -- see
  * `sectionBkgColor`/`sectionBkgColor2` below for the EVEN rows, a separate variable pair this
  * file did not know existed until round 5. */
 altSectionBkgColor: string
 /** Gantt's EVEN section-row background (`.section0`/`.section2`, quality-gate remediation,
  * round 5, corroborated by two independent reviewers measuring the real rendered DOM): a
  * SEPARATE variable pair from `altSectionBkgColor` above that this file never set, so Mermaid's
  * own un-reviewed `theme-dark.js` default was still in effect -- an arbitrary muted warm tone
  * unrelated to this app's palette, measured as the real backdrop a bar sitting in an EVEN
  * section row actually renders against (every Gantt row alternates `.section`'s own
  * `opacity: 0.2`, so this blends with whatever bar sits on top of it at 20% strength). The plain
  * crit bar (`critBkgColor` below, this file's narrowest-margin bar colour) measured only
  * 2.15:1/2.77:1 (dark/high-contrast) against that unreviewed default blended over `--card` --
  * under the 3:1 non-text floor -- while the SAME bar in an ODD row (blended with
  * `altSectionBkgColor` instead) already passed at 3.06:1/3.68:1. Matching `altSectionBkgColor`
  * here makes every row's blend identical (and already-passing) regardless of parity. */
 sectionBkgColor: string
 sectionBkgColor2: string
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
 /** Gantt clickable-task label colour (quality-gate remediation, round 2: Mermaid's default
  * here, `#003163`, measured ~1.5:1 against this app's background). Mermaid's own
  * `.taskText.clickable` rule (two classes, beats every single-class `<state>Text<N>` rule the
  * same way `getMermaidThemeCSS`'s own comment describes) applies this colour regardless of
  * which bar a clickable task's label actually sits on -- round 2's accent-coloured value only
  * ever cleared 4.5:1 against the dark plain/active/crit bars, never against the done bar
  * (Mermaid's own `doneTaskBkgColor`, a hardcoded, non-themeable `lightgrey`): measured ~1.13:1
  * there (round 5, corroborated by two independent reviewers measuring the real rendered DOM,
  * not an assumed `--card` baseline). Matches `textColor`/`taskTextOutsideColor` instead (near-
  * white: clears >=5:1 against the dark plain/crit bars). Quality-gate remediation (round 6,
  * corroborated by two independent reviewers measuring real rendered pixels): this near-white
  * value does NOT clear contrast against the active/activeCrit bars either -- `.active0`/
  * `.activeCrit0`-style fills are light (`#81B1DB`-style blue), the same shape of problem as the
  * done bar, not dark like plain/crit -- measured 2.18:1 (dark) / 2.27:1 (dark-high-contrast).
  * The done, active, and activeCrit cases are therefore ALL now handled the same way: a
  * `themeCSS` override to `taskTextDarkColor` (pure black) -- see `getMermaidThemeCSS`'s own
  * comment. */
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
  * hue-separated, high-lightness palette instead: each of `pie1`-`pie12` measures >=6.98:1
  * against both this app's `--card`/`--background` surfaces (round 5: corrected from a stale
  * `>=8.3:1` claim here -- `pie1`/`#76a9ff`, the weakest slot, actually measures 6.98:1 against
  * `--card` in the `dark` theme) and >=8.89:1 against the `pieSectionTextColor` label colour
  * below, regardless of which Refract theme is active, so one palette serves every theme.
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
  * reads at >=8.89:1 against every colour in that palette (round 5: corrected from a stale
  * `>=8.3:1` claim here). */
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
  * background).
  *
  * Quality-gate remediation (round 5, corroborated by two independent reviewers measuring the
  * real rendered DOM): the declared pair above (5.12:1/5.34:1 dark/high-contrast, see this
  * theme's own inline comment) was correct but incomplete -- Mermaid's own
  * `.eventWrapper { filter: brightness(120%) }` CSS rule (applied to every timeline event
  * regardless of section) brightens this fill by a further ~1.2x in sRGB space AFTER it is
  * declared, which no `themeVariables` key can see or patch (CSS filters are a post-paint
  * effect, not a colour substitution): the ACTUALLY-PAINTED pair measured only 3.91:1, under
  * 4.5:1, even though the declared pair above passes comfortably. No single flat fill can
  * satisfy both "declared pair clears >=3:1 against `--card`" and "post-`brightness(120%)`
  * pair still clears >=4.5:1" at once (the two constraints are contradictory once the
  * brightening is ~1.5x in linear-light space, the same kind of provable contradiction as the
  * Gantt active-overflow case above) -- so the fix instead neutralises the filter itself via
  * `themeCSS` (`.eventWrapper { filter: none !important }`, see `getMermaidThemeCSS`'s own
  * comment), which makes the declared and painted colours the same again. Slots 0-9 had enough
  * margin that the 1.2x brightening never pushed any of them below 4.5:1 in the first place, so
  * neutralising it does not reintroduce any other failure (verified in a real render). */
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
  * the page background). Round 4 "fixed" this by reusing the bright `cScale0`-`cScale7` palette
  * here, on the mistaken assumption (round 5, corroborated by two independent reviewers
  * measuring the real rendered DOM) that Journey's labels are SVG `<text>` matching Mermaid's
  * hardcoded `.label text { fill: #333 }` rule -- they are not: Journey draws labels as a plain
  * `<div class="label">` inside a `<foreignObject>`, which that `text`-descendant selector never
  * matches, and which Mermaid's OTHER `.label { color: textColor }` rule styles instead (this
  * app's own near-white `textColor`). Round 4's bright fill put light text on a light-to-bright
  * fill (measured 1.18-2.36:1, a regression that round). Round 5 fix: eight distinct, hue-
  * separated MID-TONE colours instead (same technique as `cScale11` above) -- narrowed to clear
  * BOTH `textColor` on top (>=4.5:1, needs fill luminance <=0.173/0.183 dark/high-contrast) AND
  * the pre-existing >=3:1 floor against `--card` (needs fill luminance >=0.141/0.108) at once;
  * measured >=4.8:1 against `textColor` and >=3.2:1 against `--card` in both themes. */
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
 /** gitGraph branch-name label text colour, drawn over each branch's own `gitBranchLabel<N>`-
  * sized pill, itself filled with that branch's `git<N>` colour (quality-gate remediation, round
  * 5, corroborated by two independent reviewers): Mermaid's shipped `git/styles.js` only
  * resolves this to a theme value when it is unset -- it was never set here, so it fell through
  * to Mermaid's own `theme-dark.js` default (`labelTextColor`/its RGB invert, both an idiomatic
  * light grey close to `lightgrey`), measured 1.15-1.56:1 against this file's own bright `git0`-
  * `git7` pills above. Pure black clears >=8.89:1 against every one of them. */
 gitBranchLabel0: string
 gitBranchLabel1: string
 gitBranchLabel2: string
 gitBranchLabel3: string
 gitBranchLabel4: string
 gitBranchLabel5: string
 gitBranchLabel6: string
 gitBranchLabel7: string
 /** Cluster/subgraph title text colour (flowchart `.cluster text`). Gate round 3 fix (Main,
  * #1074 follow-up): Mermaid's own `theme-dark.js` hardcodes BOTH this field (previously
  * `#F9FFFE`, independent of every theme-specific field above) AND its real `clusterBkg`
  * backdrop to a literal `#474949` -- NOT `tertiaryColor` (same hardcode-over-override pattern
  * `primaryTextColor`'s own comment documents for `mainBkg`/`nodeBkg`), confirmed by reading
  * that source directly. This file never set `titleColor` before, so every preset fell through
  * to the one fixed near-white default regardless of its own palette. FR-023's 0.9 tier, same
  * methodology as `primaryTextColor` above: white at 90% alpha composited over this REAL
  * `#474949` backdrop measures 7.39:1 -- not the `--card` ratio this comment previously
  * (wrongly) cited; still clears 4.5:1, so no value change, documentation only. */
 titleColor: string
}

// Per-theme data (DARK_FAMILY plus every `MERMAID_THEME_VARIABLES` entry, including #551's
// `nordic-frost`/`cyber-amber`) lives in `mermaidThemeData.ts` -- extracted out of this file
// (#806 file-size ratchet: #551's two new entries pushed this file past its own recorded
// baseline, which is lower-only; same "pure-data, behaviour-preserving move" #564 used for
// scripts/theme-contrast-pairs.mjs). Re-exported here so Markdown.tsx's own import site, and
// `getMermaidThemeCSS` below, are unaffected.
export { MERMAID_THEME_VARIABLES } from './mermaidThemeData'
import { MERMAID_THEME_VARIABLES } from './mermaidThemeData'

// Quality-gate remediation (round 5, corroborated by two independent reviewers measuring the
// real rendered DOM): three real Mermaid CSS gaps that no `themeVariables` key can patch alone
// -- each needs an ADDITIONAL CSS rule injected via Mermaid's own documented `themeCSS` init
// option (`mermaid.initialize({ ..., themeCSS: getMermaidThemeCSS(activeThemeId) })`, see
// Markdown.tsx's own call site), which Mermaid's `createUserStyles` appends -- already scoped to
// the diagram's own `#id` automatically -- after Mermaid's own generated stylesheet, so a rule
// here can out-specificity one of Mermaid's shipped rules without touching node_modules:
//
// 1. Gantt active/activeCrit overflow labels -- see this file's header comment, point 1. A
//    two-class selector Mermaid's shipped `gantt/styles.js` never defines for these states
//    (`.activeText<N>.taskTextOutsideLeft`/`Right`, `.activeCritText<N>.taskTextOutsideLeft`/
//    `Right`) beats the single-class `!important` rule meant for the INSIDE-bar case on
//    specificity alone (two classes beat one, regardless of source order, since both are
//    `!important`) -- measured 8.89-19.25:1 afterward, up from 1.05-2.26:1.
// 2. Gantt clickable task labels -- see `taskTextClickableColor`'s own interface comment. A
//    three-class override (`.taskText.clickable.doneText<N>`) beats Mermaid's generic two-class
//    `.taskText.clickable` rule the same way, so only the done-bar case (Mermaid's hardcoded,
//    non-themeable `lightgrey` `doneTaskBkgColor`) gets a dark fill; every other bar a clickable
//    label can sit on is handled by `taskTextClickableColor` itself.
// 3. Timeline section-10 -- see `cScale11`'s own interface comment. Mermaid's own
//    `.eventWrapper { filter: brightness(120%) }` rule brightens every timeline event's fill
//    AFTER it is declared, a post-paint effect no `themeVariables` key can see or patch --
//    neutralising the filter outright removes the discrepancy (every other slot had enough
//    margin that the brightening never pushed it below 4.5:1 in the first place).
//
// KNOWN LIMITATION: the background-resolution logic in scripts/mermaid-contrast-measure.mjs's
// `accumulatedBrightness` (not `check-mermaid-contrast.mjs` -- a stale misattribution in an
// earlier version of this comment, corrected round 6) that verifies all three of these models
// ONLY the `brightness()` filter function (the one real case above), not Mermaid's full CSS
// `filter` grammar (`contrast()`, `saturate()`, `hue-rotate()`, `grayscale()`, `sepia()`,
// `invert()`, `blur()`, `drop-shadow()`). Round 6 narrowed this limitation's blast radius: TEXT
// contrast no longer resolves its background this way at all (see that file's own header
// comment for the screenshot-pixel-diff replacement, which needs no filter-grammar modelling
// because it reads real post-filter pixels directly) -- only the remaining SHAPE-vs-background
// checks (`measureShapes`) still use `accumulatedBrightness`, so a future shape fixture relying
// on an unmodelled filter function would silently under- or over-state its measured contrast
// until that function is widened to match.
export function getMermaidThemeCSS(themeId: ThemeId): string {
 const t = MERMAID_THEME_VARIABLES[themeId]
 const overflowStates = ['activeText', 'activeCritText']
 const overflowSelectors = overflowStates
  .flatMap((state) => [0, 1, 2, 3].map((n) => `${state}${n}`))
  .flatMap((cls) => [`.${cls}.taskTextOutsideLeft`, `.${cls}.taskTextOutsideRight`])
  .join(',\n  ')
 // Quality-gate remediation (round 6): the done-bar case below only ever covered
 // `.taskText.clickable.doneText<N>` -- a clickable task's label sitting on an ACTIVE or
 // activeCrit bar (also a light fill, same as done) still fell through to Mermaid's generic
 // `.taskText.clickable` rule (`taskTextClickableColor`, this file's near-white default), measured
 // 2.18:1 (dark) / 2.27:1 (dark-high-contrast). Same three-class-beats-two-class fix, same dark
 // colour, for both remaining light-fill bar types -- see `taskTextClickableColor`'s own interface
 // comment for why it can no longer document "clears >=5:1 against every bar" unqualified.
 const clickableSelectors = ['doneText', 'activeText', 'activeCritText']
  .flatMap((state) => [0, 1, 2, 3].map((n) => `.taskText.clickable.${state}${n}`))
  .join(',\n  ')
 // Gate round 3 fix (Main, #1074 follow-up, HIGH): Journey task and section labels render via
 // Mermaid's own default `textPlacement: 'fo'` path -- a foreignObject `<div class="label">`
 // sibling of the coloured `.task-type-N`/`.section-type-N` rect (confirmed by reading
 // node_modules/mermaid's own journeyDiagram/svgDraw source directly: `byFo` appends the
 // switch/foreignObject/div.label as a SIBLING of the rect inside the same `<g>`, so `~`
 // reliably selects it). Mermaid's own `.label { color: textColor }` rule therefore paints
 // these labels with this file's SOFTENED `textColor` (#1074's alpha tier), composited
 // against Journey's own coloured `fillType0`-`fillType7` fills -- FIXED, independent literal
 // hex values (NOT derived from `primaryColor`/`secondaryColor`, see that interface comment)
 // -- measured as low as 4.06:1, below the 4.5:1 floor. These labels sit on a genuine
 // coloured, non-neutral fill, the same solid-text exception Gantt's own task bars already
 // carry -- reusing `taskTextColor` (already solid, already tuned for exactly this "light text
 // on a coloured task-bar fill" role) rather than inventing a new token.
 // Timeline uses the identical renderer code path: its own `textPlacement` also defaults to
 // `'fo'` and its svgDraw source emits the identical `task`/`journey-section` class names
 // (confirmed by reading node_modules/mermaid's own timeline-definition source directly), so
 // this selector likely reaches it too -- NOT separately verified: this story's fixture has no
 // Timeline fence and #1108 stays Gantt-only scope, so Timeline coverage here is an inferred
 // likelihood, not a proven fact.
 // Kept OUTSIDE the template literal below (gate round 3, UI-review fix): a comment INSIDE the
 // return statement ships verbatim inside every Mermaid SVG's own embedded `<style>` block, not
 // only the compiled JS bundle.
 return `
  ${overflowSelectors} {
    fill: ${t.taskTextOutsideColor} !important;
  }
  ${clickableSelectors} {
    fill: ${t.taskTextDarkColor} !important;
  }
  .eventWrapper {
    filter: none !important;
  }
  /* Quality-gate remediation (round 6): gitGraph's own \`.commit-label-bkg\` rect ships at
     \`opacity: 0.5\`, so wherever a commit sits on a bright \`git<N>\` branch line, the line shows
     through the label's own background at 50% strength and the default commit-label text colour
     (#b8b6b6) can measure as low as 1.4-2.0:1 against that blend (real screenshot-pixel
     measurement, not CSS reading -- see scripts/check-mermaid-contrast.mjs's own
     measureTextFromScreenshots). Forcing the label background fully opaque removes the blend
     entirely: measured ~7.6:1 (text #b8b6b6 on the now-opaque #2b2b2b label background)
     afterward, verified live via the same real-pixel harness. */
  .commit-label-bkg {
    opacity: 1 !important;
  }
  .task ~ switch .label,
  .journey-section ~ switch .label {
    color: ${t.taskTextColor} !important;
  }
`
}
