// Issue #1082 (spec 004 FR-033): the Context usage figures take a colour blended in OKLCH between
// four per-theme tokens (`--context-usage-0/-30/-70/-100`), the same way the renderer's
// `color-mix(in oklch, ...)` does (`contextUsageColor.ts`). Every blend sampled at each 10% step
// must meet 4.5:1 against the surface the readout sits on: the page `--background`, and the
// composer's own `--composer-background` wherever that is opaque. Kept in its own module for the
// #806 file-size ratchet, like `focused-badge-contrast.mjs`.
import { clamp01, contrastRatio, linearToHex, oklabToLinearSrgb, relativeLuminance } from './contrast-math.mjs'

const STOPS = [0, 30, 70, 100]
const BACKDROPS = ['background', 'composer-background']

function linearSrgbToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

function toOklch(linear) {
  const [L, a, b] = linearSrgbToOklab(linear)
  const C = Math.hypot(a, b)
  return { L, C, H: C < 1e-4 ? null : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 }
}

/** CSS `color-mix(in oklch, A, B)` with the default shorter-hue rule; an achromatic stop's hue is
 * powerless, so the other stop's hue is used. `t` is B's share (0..1). */
function mixOklch(A, B, t) {
  let hA = A.H ?? B.H ?? 0
  let hB = B.H ?? A.H ?? 0
  if (hB - hA > 180) hA += 360
  else if (hA - hB > 180) hB += 360
  const H = (hA + (hB - hA) * t) % 360
  const L = A.L + (B.L - A.L) * t
  const C = A.C + (B.C - A.C) * t
  const rad = (H * Math.PI) / 180
  return oklabToLinearSrgb(L, C * Math.cos(rad), C * Math.sin(rad)).map(clamp01)
}

/** Linear sRGB of the context-usage colour at `percent` (0-100), from the theme's four stops. */
export function contextUsageLinear(stops, percent) {
  const p = Math.min(100, Math.max(0, percent))
  const upper = STOPS.findIndex((stop) => stop >= p && stop > 0)
  const lo = STOPS[upper - 1]
  const hi = STOPS[upper]
  return mixOklch(stops[lo], stops[hi], (p - lo) / (hi - lo))
}

export function contextUsageContrastRows(themes) {
  const rows = []
  for (const [themeId, props] of Object.entries(themes)) {
    const entries = STOPS.map((stop) => props[`context-usage-${stop}`])
    if (entries.some((entry) => !entry)) {
      rows.push({ themeId, fg: 'context-usage-*', bg: 'background', min: 4.5, ratio: null, pass: false, note: 'token missing' })
      continue
    }
    const stops = Object.fromEntries(STOPS.map((stop, i) => [stop, toOklch(entries[i].linear)]))
    for (const backdropName of BACKDROPS) {
      const backdrop = props[backdropName]
      // A transparent `--composer-background` (Dark, Obsidian and others since #927) is the page
      // background itself, already measured by the `background` pass.
      if (!backdrop || backdrop.alpha < 1) continue
      for (let percent = 0; percent <= 100; percent += 10) {
        const fgLinear = contextUsageLinear(stops, percent)
        const ratio = contrastRatio(relativeLuminance(fgLinear), relativeLuminance(backdrop.linear))
        rows.push({ themeId, fg: `context-usage @${percent}%`, bg: backdropName, min: 4.5, ratio, pass: ratio >= 4.5, fgHex: linearToHex(fgLinear), bgHex: linearToHex(backdrop.linear) })
      }
    }
  }
  return rows
}
