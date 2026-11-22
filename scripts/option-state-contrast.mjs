// The Ask card's option rows: hover is `--muted` + 5% `--foreground`, selected is `--muted` + 12% `--primary` (`--color-option-hover-bg`,
// `--color-option-selected-bg`). Row text must keep 4.5:1 on both fills; the 2px `--primary` edge is a secondary cue (the dot or tick
// is the other), so its 3:1 against the selected fill is informational. The oklab mix tracks the CSS oklch mix to ~0.03 in ratio.
import { contrastRatio, linearToHex, relativeLuminance, resolvedLinear } from './contrast-math.mjs'
import { mixEntries } from './recommended-hover-contrast.mjs'

const FILLS = [
  { label: 'option hover fill (muted + 5% foreground)', tint: 'foreground', weight: 0.05 },
  { label: 'option selected fill (muted + 12% primary)', tint: 'primary', weight: 0.12 }
]

export function optionStateContrastRows(themes) {
  const rows = []
  for (const [themeId, props] of Object.entries(themes)) {
    const base = props['muted']
    for (const { label, tint, weight } of FILLS) {
      const over = props[tint]
      const missing = !base ? 'muted' : !over ? tint : null
      if (missing) {
        rows.push({ themeId, fg: missing, bg: label, min: 4.5, ratio: null, pass: false, note: 'token missing' })
        continue
      }
      const surface = { raw: label, alpha: 1, linear: resolvedLinear(mixEntries(base, over, weight, label), props['card'] ?? base) }
      const surfaceLum = relativeLuminance(surface.linear)
      for (const name of ['foreground', 'muted-foreground']) {
        const entry = props[name]
        if (!entry) {
          rows.push({ themeId, fg: name, bg: label, min: 4.5, ratio: null, pass: false, note: 'token missing' })
          continue
        }
        const fgLinear = resolvedLinear(entry, surface)
        const ratio = contrastRatio(relativeLuminance(fgLinear), surfaceLum)
        rows.push({ themeId, fg: name, bg: label, min: 4.5, ratio, pass: ratio >= 4.5, fgHex: linearToHex(fgLinear), bgHex: linearToHex(surface.linear) })
      }
      if (tint === 'primary') {
        const edgeLinear = resolvedLinear(over, surface)
        const ratio = contrastRatio(relativeLuminance(edgeLinear), surfaceLum)
        rows.push({ themeId, fg: 'primary (left edge)', bg: label, min: 3, ratio, pass: ratio >= 3, fgHex: linearToHex(edgeLinear), bgHex: linearToHex(surface.linear), informational: true, note: 'informational: the dot or tick carries the pick too' })
      }
    }
  }
  return rows
}
