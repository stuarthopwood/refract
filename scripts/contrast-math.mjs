// Shared WCAG contrast / sRGB alpha-compositing primitives, extracted out of
// check-theme-contrast.mjs (gate round 5 follow-up, Main's finding 1): theme-contrast-pairs.mjs
// had grown its own byte-for-byte DUPLICATE copy of this exact math (to dodge
// check-theme-contrast.mjs's own lower-only #806 file-size ratchet), and a transcription slip in
// that duplicate silently regressed the gamma-space compositing fix below back to a naive
// linear-space blend before it was caught. One copy, imported by both, so there is only ever one
// place this math can drift.

export function clamp01(x) {
  return Math.min(1, Math.max(0, x))
}

export function srgbGammaDecode(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

// Linear sRGB -> gamma sRGB, for the hex debug column only (display, never fed back into the
// WCAG luminance formula, which operates on linear values directly).
export function srgbGammaEncode(c) {
  const clamped = Math.min(1, Math.max(0, c))
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055
}

// Quality-gate remediation (HIGH, corroborated by code-reviewer/test-reviewer/accessibility-
// auditor): browsers alpha-composite in gamma-encoded sRGB space, not linear light -- blending
// in linear space (the old behaviour here) understated how much a semi-transparent token lets
// the backdrop show through. A reviewer independently confirmed with node that `.theme-dark`'s
// `--border` (16% alpha) was reported 4.01:1 by the old linear blend but is actually only
// 1.53:1 as really rendered. Fix: gamma-encode both operands, blend in that gamma space (what
// the compositor does), then gamma-decode the blended result back to linear before computing
// WCAG relative luminance.
export function compositeOverLinear(fg, bg) {
  return fg.linear.map((c, i) => {
    const fgGamma = srgbGammaEncode(clamp01(c))
    const bgGamma = srgbGammaEncode(clamp01(bg.linear[i]))
    return srgbGammaDecode(clamp01(fg.alpha * fgGamma + (1 - fg.alpha) * bgGamma))
  })
}

export function resolvedLinear(propEntry, backdropEntry) {
  if (propEntry.alpha >= 1) return propEntry.linear.map(clamp01)
  return compositeOverLinear(propEntry, backdropEntry)
}

export function relativeLuminance([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(lumA, lumB) {
  const lighter = Math.max(lumA, lumB)
  const darker = Math.min(lumA, lumB)
  return (lighter + 0.05) / (darker + 0.05)
}

export function linearToHex([r, g, b]) {
  const toByte = (c) => Math.round(srgbGammaEncode(c) * 255)
  return '#' + [r, g, b].map((c) => toByte(c).toString(16).padStart(2, '0')).join('')
}
