// Gate round 5 fix (#1050, test review): `--composer-selection-bg` is now a TRANSLUCENT
// accent-text tint (`color-mix(in oklab, var(--accent-text) N%, transparent)`, per-theme N, globals.css),
// not an opaque alias -- `CommandPillOverlay.tsx`'s own header comment has the full product
// reasoning (round 3's opaque `var(--accent)` fill happened to measure EQUAL to
// `--command-pill-bg` in Nordic Frost/Cyber Amber, painting a completely invisible highlight
// over a selected pill). `theme-contrast-pairs.mjs`'s own generic PAIRS loop cannot check a
// translucent `bg` operand correctly any more: it computes `bgLinear = resolvedLinear(bgEntry,
// bgEntry)`, i.e. composites the colour over ITSELF when its alpha is below 1 -- meaningless for
// a highlight whose real backdrop is `--command-pill-bg`, `--background` or (Dark high contrast
// only) `--composer-background`, never its own colour. This module composites it over each of
// those REAL backdrops instead, the same gamma-space `compositeOverLinear` math every other
// alpha-aware check in this codebase already shares (contrast-math.mjs).
//
// Two questions per backdrop: is the highlight itself legible under its own `--composer-
// selection-fg` text (>=4.5:1, >=7:1 in Dark high contrast -- enforced), and is the highlight
// visibly distinct from what it sits on (enforced >=1.5:1 against `--command-pill-bg` only;
// informational-only, never failing the run, against `--background`/`--composer-background`).
// The real constraint on the alpha is the text floor: Dark high contrast's 7:1 floor leaves no
// headroom at the 34% it keeps, while the other themes carry the highest alpha (42%-50%,
// `globals.css`) their own 4.5:1 floor allows (#1084). No theme reaches 3:1 over its near-black
// backdrop, so those rows stay informational (accepted departure, `docs/design/accessibility.md`).
//
// A brand-new file, not an addition to theme-contrast-pairs.mjs: that file is 599 lines on
// `origin/main` with no #806 baseline entry (naturally under its 600-line cap) -- every PAIRS
// entry #1050 needs (the command-pill ones below, and `composerSelectionContrastRows` above)
// lives here instead, so that file never crosses its cap and never needs a baseline entry
// manually added to grandfather it back in (the same reason contrast-math.mjs itself was
// extracted out of check-theme-contrast.mjs in an earlier gate round).
import { contrastRatio, linearToHex, relativeLuminance, resolvedLinear } from './contrast-math.mjs'

// Issue #1050 (composer command pill, gate round 2): two independent tokens -- `--command-pill-
// bg` clears only 1.4:1 vs composer, `--command-pill-fg` (a lightened `--accent-text` hue)
// clears only the text floor on that fill; see globals.css for the measured numbers. Plain
// `{ fg, bg, min }` rows, the same shape `theme-contrast-pairs.mjs`'s own `PAIRS` export uses --
// merged into that same array by `check-theme-contrast.mjs`'s main loop, just not declared in
// that file (see this module's own header comment for why).
export const COMMAND_PILL_PAIRS = [
  { fg: 'command-pill-fg', bg: 'command-pill-bg', min: 4.5 },
  { fg: 'command-pill-fg', bg: 'command-pill-bg', min: 7, onlyThemes: ['dark-high-contrast'] },
  { fg: 'command-pill-bg', bg: 'background', min: 1.4, onlyThemes: ['dark', 'obsidian', 'nordic-frost', 'cyber-amber'] },
  { fg: 'command-pill-bg', bg: 'composer-background', min: 1.4, onlyThemes: ['dark-high-contrast'] },
]

export function composerSelectionContrastRows(themes) {
  const rows = []
  for (const [themeId, props] of Object.entries(themes)) {
    const selectionBg = props['composer-selection-bg']
    const selectionFg = props['composer-selection-fg']
    const pillBg = props['command-pill-bg']
    const background = props['background']
    const composerBackground = props['composer-background']
    if (!selectionBg || !selectionFg || !pillBg || !background) {
      rows.push({
        themeId,
        fg: 'composer-selection-fg',
        bg: 'composer-selection-bg',
        min: 4.5,
        ratio: null,
        pass: false,
        note: 'token missing',
      })
      continue
    }
    const min = themeId === 'dark-high-contrast' ? 7 : 4.5

    const overPill = resolvedLinear(selectionBg, pillBg)
    const pillDistinctRatio = contrastRatio(relativeLuminance(overPill), relativeLuminance(pillBg.linear))
    rows.push({
      themeId,
      fg: 'composer-selection-bg',
      bg: 'command-pill-bg (selection over the pilled token)',
      min: 1.5,
      ratio: pillDistinctRatio,
      pass: pillDistinctRatio >= 1.5,
      fgHex: linearToHex(overPill),
      bgHex: linearToHex(pillBg.linear),
    })
    // Gate-fix (#1074 round 1, Code/Test HIGH): `composer-selection-fg` used to alias
    // `--accent-foreground` -> `--foreground`, translucent in every non-HC preset -- reading
    // `.linear` directly (the old code here) scored it as if fully opaque. `resolvedLinear`
    // against the real composited backdrop composites that alpha in properly (now moot for the
    // DECIDED fix below, which makes this token solid again, but kept correct defensively).
    const pillLegibilityFgLinear = resolvedLinear(selectionFg, { raw: 'over-pill', alpha: 1, linear: overPill })
    const pillLegibilityRatio = contrastRatio(relativeLuminance(pillLegibilityFgLinear), relativeLuminance(overPill))
    rows.push({
      themeId,
      fg: 'composer-selection-fg',
      bg: 'composer-selection-bg (on command-pill-bg)',
      min,
      ratio: pillLegibilityRatio,
      pass: pillLegibilityRatio >= min,
      fgHex: linearToHex(pillLegibilityFgLinear),
      bgHex: linearToHex(overPill),
    })

    const overBackground = resolvedLinear(selectionBg, background)
    const bgLegibilityFgLinear = resolvedLinear(selectionFg, { raw: 'over-background', alpha: 1, linear: overBackground })
    const bgLegibilityRatio = contrastRatio(relativeLuminance(bgLegibilityFgLinear), relativeLuminance(overBackground))
    rows.push({
      themeId,
      fg: 'composer-selection-fg',
      bg: 'composer-selection-bg (on background)',
      min,
      ratio: bgLegibilityRatio,
      pass: bgLegibilityRatio >= min,
      fgHex: linearToHex(bgLegibilityFgLinear),
      bgHex: linearToHex(overBackground),
    })
    const bgDistinctRatio = contrastRatio(relativeLuminance(overBackground), relativeLuminance(background.linear))
    rows.push({
      themeId,
      fg: 'composer-selection-bg',
      bg: 'background',
      min: 3,
      ratio: bgDistinctRatio,
      pass: true,
      fgHex: linearToHex(overBackground),
      bgHex: linearToHex(background.linear),
      note:
        bgDistinctRatio >= 3
          ? 'informational, not enforced'
          : `informational -- below 3:1 (${bgDistinctRatio.toFixed(2)}:1); a near-black backdrop is below 3:1 in every theme, an accepted departure (accessibility.md), not a WCAG-enforced one (#1050 gate round 5, #1084)`,
    })

    if (composerBackground) {
      const overComposerBg = resolvedLinear(selectionBg, composerBackground)
      const cbgLegibilityFgLinear = resolvedLinear(selectionFg, { raw: 'over-composer-background', alpha: 1, linear: overComposerBg })
      const cbgLegibilityRatio = contrastRatio(relativeLuminance(cbgLegibilityFgLinear), relativeLuminance(overComposerBg))
      rows.push({
        themeId,
        fg: 'composer-selection-fg',
        bg: 'composer-selection-bg (on composer-background)',
        min,
        ratio: cbgLegibilityRatio,
        pass: cbgLegibilityRatio >= min,
        fgHex: linearToHex(cbgLegibilityFgLinear),
        bgHex: linearToHex(overComposerBg),
      })
      const cbgDistinctRatio = contrastRatio(relativeLuminance(overComposerBg), relativeLuminance(composerBackground.linear))
      rows.push({
        themeId,
        fg: 'composer-selection-bg',
        bg: 'composer-background',
        min: 3,
        ratio: cbgDistinctRatio,
        pass: true,
        fgHex: linearToHex(overComposerBg),
        bgHex: linearToHex(composerBackground.linear),
        note:
          cbgDistinctRatio >= 3
            ? 'informational, not enforced'
            : `informational -- below 3:1 (${cbgDistinctRatio.toFixed(2)}:1); same accepted gap as the background row above (#1050 gate round 5)`,
      })
    }
  }
  return rows
}
