// Contrast rows for the translucent `--composer-selection-bg`, composited over its real backdrops (pill, background,
// composer-background); the generic PAIRS loop would composite it over itself. Text is enforced; distinctness vs background is informational.
// Lives in its own file to keep theme-contrast-pairs.mjs under the 600-line cap.
import { contrastRatio, linearToHex, relativeLuminance, resolvedLinear } from './contrast-math.mjs'

// Plain `{ fg, bg, min }` rows merged into PAIRS by `check-theme-contrast.mjs`; see globals.css for the measured numbers.
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
    // Resolve the possibly-translucent fg against the composited backdrop rather than reading `.linear` as if opaque.
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
