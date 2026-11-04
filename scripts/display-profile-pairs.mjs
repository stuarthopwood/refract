// The #553 pair list and measurement, shared by check-display-profiles.mjs (offline, parsed CSS) and the live
// #1590 theme driver (tokens resolved in the real webview), so both count offenders the same way.

import { contrastRatio, relativeLuminance, resolvedLinear } from './contrast-math.mjs'
import { applyProfile, lightness } from './display-profiles.mjs'

export const STEP = 'step'
export const RATIO = 'ratio'

// A step pair needs `a` at least `min` L* above `b` on a dark theme and `min` L* below it on a light one (the surface
// ladder runs lighter for dark presets, darker for light); a ratio pair needs a WCAG contrast of at least `min`.
// A translucent `a` is composited over `b`, the surface it sits on.
export const PAIRS = [
  { name: 'card vs canvas', kind: STEP, a: 'card', b: 'background', min: 5 },
  { name: 'popover vs canvas', kind: STEP, a: 'popover', b: 'background', min: 5 },
  { name: 'sidebar vs canvas', kind: STEP, a: 'sidebar', b: 'background', min: 2.3 },
  { name: 'divider vs canvas', kind: RATIO, a: 'divider', b: 'background', min: 1.5 },
  { name: 'divider vs card', kind: RATIO, a: 'divider', b: 'card', min: 1.5 },
  { name: 'control edge vs canvas', kind: RATIO, a: 'border', b: 'background', min: 3 },
  { name: 'control edge vs card', kind: RATIO, a: 'border', b: 'card', min: 3 },
  { name: 'input edge vs canvas', kind: RATIO, a: 'input', b: 'background', min: 3 },
  { name: 'input edge vs card', kind: RATIO, a: 'input', b: 'card', min: 3 },
  { name: 'muted text vs canvas', kind: RATIO, a: 'muted-foreground', b: 'background', min: 4.5 },
  { name: 'muted text vs card', kind: RATIO, a: 'muted-foreground', b: 'card', min: 4.5 },
]

export function measure(pair, themeId, props, profile) {
  const a = props[pair.a]
  const b = props[pair.b]
  if (!a || !b) return null
  let lumA = relativeLuminance(resolvedLinear(a, b))
  // `b` is opaque, so resolvedLinear returns it unchanged; the second argument is only a placeholder backdrop.
  let lumB = relativeLuminance(resolvedLinear(b, b))
  if (profile) {
    lumA = applyProfile(lumA, profile)
    lumB = applyProfile(lumB, profile)
  }
  if (pair.kind !== STEP) return contrastRatio(lumA, lumB)
  const step = lightness(lumA) - lightness(lumB)
  return /^light/.test(themeId) ? -step : step
}

/** Pairs that miss their threshold under `profile`, whether or not they already miss with no profile applied. */
export function offendersUnderProfile(themeId, props, profile) {
  return PAIRS.filter((pair) => {
    const shown = measure(pair, themeId, props, profile)
    return shown === null || shown < pair.min - 1e-9
  })
}
