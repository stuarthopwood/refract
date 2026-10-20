// Gate round 5 fix (#1050, test review): `--composer-selection-bg` is now a TRANSLUCENT
// accent-text tint (`color-mix(in oklab, var(--accent-text) 34%, transparent)`, globals.css),
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
// visibly distinct from what it sits on (enforced >=1.5:1 against `--command-pill-bg` only --
// the test-review finding this round fixes; informational-only, never failing the run, against
// `--background`/`--composer-background`, since no alpha anywhere near the 30-40% window this
// decision specified reaches a full 3:1 over a near-black backdrop without blowing the text-
// legibility floor above -- a clearly accent-hued tint there, not a WCAG-enforced one, the same
// accepted-gap shape `sidebarBorderContrastRows` in theme-contrast-pairs.mjs already uses).
//
// A brand-new file, not an addition to theme-contrast-pairs.mjs: that file sits exactly at its
// own #806 file-size baseline (604 lines) with zero headroom, the same reason contrast-math.mjs
// itself was extracted out of check-theme-contrast.mjs in an earlier gate round.
import { contrastRatio, linearToHex, relativeLuminance, resolvedLinear } from './contrast-math.mjs'

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
    const pillLegibilityRatio = contrastRatio(relativeLuminance(selectionFg.linear), relativeLuminance(overPill))
    rows.push({
      themeId,
      fg: 'composer-selection-fg',
      bg: 'composer-selection-bg (on command-pill-bg)',
      min,
      ratio: pillLegibilityRatio,
      pass: pillLegibilityRatio >= min,
      fgHex: linearToHex(selectionFg.linear),
      bgHex: linearToHex(overPill),
    })

    const overBackground = resolvedLinear(selectionBg, background)
    const bgLegibilityRatio = contrastRatio(relativeLuminance(selectionFg.linear), relativeLuminance(overBackground))
    rows.push({
      themeId,
      fg: 'composer-selection-fg',
      bg: 'composer-selection-bg (on background)',
      min,
      ratio: bgLegibilityRatio,
      pass: bgLegibilityRatio >= min,
      fgHex: linearToHex(selectionFg.linear),
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
          : `informational -- below 3:1 (${bgDistinctRatio.toFixed(2)}:1); a 34% accent tint cannot reach 3:1 over a near-black background without exceeding the text-legibility floor above, so this is a clearly accent-hued tint, not a WCAG-enforced one (#1050 gate round 5, accepted)`,
    })

    if (composerBackground) {
      const overComposerBg = resolvedLinear(selectionBg, composerBackground)
      const cbgLegibilityRatio = contrastRatio(relativeLuminance(selectionFg.linear), relativeLuminance(overComposerBg))
      rows.push({
        themeId,
        fg: 'composer-selection-fg',
        bg: 'composer-selection-bg (on composer-background)',
        min,
        ratio: cbgLegibilityRatio,
        pass: cbgLegibilityRatio >= min,
        fgHex: linearToHex(selectionFg.linear),
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
