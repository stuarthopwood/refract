// The Ask card's recommended row on hover/checked-hover is `color-mix(in oklch, var(--severity-success-bg), var(--foreground) 5%)`.
// Both inputs are translucent, so the mix is premultiplied, then composited over the surface the row sits on. A plain PAIRS
// The oklab mix differs from the CSS oklch mix by at most ~0.03 in contrast ratio on the tightest themes.
import { contrastRatio, linearToHex, oklabToLinearSrgb, relativeLuminance, resolvedLinear } from './contrast-math.mjs'

const MIX_WEIGHT = 0.05

function linearToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}

export function hoveredTintEntry(tint, foreground) {
  const alpha = (1 - MIX_WEIGHT) * tint.alpha + MIX_WEIGHT * foreground.alpha
  const tintLab = linearToOklab(tint.linear)
  const fgLab = linearToOklab(foreground.linear)
  const lab = tintLab.map((c, i) => ((1 - MIX_WEIGHT) * tint.alpha * c + MIX_WEIGHT * foreground.alpha * fgLab[i]) / alpha)
  return { raw: 'recommended-hover', alpha, linear: oklabToLinearSrgb(lab).map((c) => Math.min(1, Math.max(0, c))) }
}

export function recommendedHoverContrastRows(themes) {
  const rows = []
  for (const [themeId, props] of Object.entries(themes)) {
    for (const backdropName of ['background', 'card']) {
      const bg = `severity-success-bg + 5% foreground (hover) on ${backdropName}`
      const backdrop = props[backdropName]
      const tint = props['severity-success-bg']
      const foreground = props['foreground']
      const missing = !backdrop ? backdropName : !tint ? 'severity-success-bg' : !foreground ? 'foreground' : null
      if (missing) {
        rows.push({ themeId, fg: missing, bg, min: 4.5, ratio: null, pass: false, note: 'token missing' })
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
