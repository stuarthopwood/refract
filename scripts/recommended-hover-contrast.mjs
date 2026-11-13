// The Ask card's recommended row on hover/checked-hover is `color-mix(in oklch, var(--severity-success-bg), var(--foreground) 5%)`.
// Both inputs are translucent, so the mix is premultiplied, then composited over the surface the row sits on. A plain PAIRS
// row cannot express that. Mixed in oklab: at a 5% weight it matches the oklch mix to well under one 8-bit step.
import { contrastRatio, linearToHex, relativeLuminance, resolvedLinear } from './contrast-math.mjs'

const MIX_WEIGHT = 0.05

function linearToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}

function oklabToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
}

export function hoveredTintEntry(tint, foreground) {
  const alpha = (1 - MIX_WEIGHT) * tint.alpha + MIX_WEIGHT * foreground.alpha
  const tintLab = linearToOklab(tint.linear)
  const fgLab = linearToOklab(foreground.linear)
  const lab = tintLab.map((c, i) => ((1 - MIX_WEIGHT) * tint.alpha * c + MIX_WEIGHT * foreground.alpha * fgLab[i]) / alpha)
  return { raw: 'recommended-hover', alpha, linear: oklabToLinear(lab).map((c) => Math.min(1, Math.max(0, c))) }
}

export function recommendedHoverContrastRows(themes) {
  const rows = []
  for (const [themeId, props] of Object.entries(themes)) {
    for (const backdropName of ['background', 'card']) {
      const bg = `severity-success-bg + 5% foreground (hover) on ${backdropName}`
      const backdrop = props[backdropName]
      const tint = props['severity-success-bg']
      const foreground = props['foreground']
      if (!backdrop || !tint || !foreground) {
        rows.push({ themeId, fg: 'severity-success/muted-foreground', bg, min: 4.5, ratio: null, pass: false, note: 'token missing' })
        continue
      }
      const surface = { raw: bg, alpha: 1, linear: resolvedLinear(hoveredTintEntry(tint, foreground), backdrop) }
      const surfaceLum = relativeLuminance(surface.linear)
      for (const name of ['severity-success', 'muted-foreground', 'foreground']) {
        const entry = props[name]
        if (!entry) {
          rows.push({ themeId, fg: name, bg, min: 4.5, ratio: null, pass: false, note: 'token missing' })
          continue
        }
        const fgLinear = resolvedLinear(entry, surface)
        const ratio = contrastRatio(relativeLuminance(fgLinear), surfaceLum)
        rows.push({ themeId, fg: name, bg, min: 4.5, ratio, pass: ratio >= 4.5, fgHex: linearToHex(fgLinear), bgHex: linearToHex(surface.linear) })
      }
    }
  }
  return rows
}
