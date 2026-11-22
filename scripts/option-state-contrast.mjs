// Ask card option rows: hover (`--muted` + 5% `--foreground`) and selected (`--muted` + 12% `--primary`) fills must keep 4.5:1 text.
// The 2px `--primary` edge is a secondary cue (the dot or tick is the other), so its 3:1 is informational.
import { contrastRatio, linearToHex, relativeLuminance, resolvedLinear } from './contrast-math.mjs'
import { mixEntries } from './recommended-hover-contrast.mjs'

const FILLS = [
  // Weights mirror the `--color-option-*` color-mix percentages in src/renderer/styles/globals.css; keep in sync.
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
