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

export function oklabToLinearSrgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  ].map(clamp01)
}

// Parses a `getComputedStyle()` colour string (rgb()/rgba()/oklch()/oklab()/'transparent') into
// `{ raw, alpha, linear }`, the shape every function above already works with. Extracted from
// `verify-927-928-quiet-composer.mjs` (file-size #806 ratchet: a live-check script that defined
// this colour math locally grew past the 600-line soft cap) -- WebView2/Chromium reports
// `@theme`/`color-mix()` tokens as `oklch()`/`oklab()`, not `rgb()`, so both are parsed via the
// same OKLab->linear-sRGB matrices every modern browser uses internally (which already yield
// LINEAR values -- only `rgb()`/`rgba()` bytes still need `srgbGammaDecode`).
export function parseComputedColorToEntry(raw) {
  const str = (raw ?? '').trim()
  if (str === 'transparent') return { raw, alpha: 0, linear: [0, 0, 0] }
  const rgbMatch = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(str)
  if (rgbMatch) {
    const [, r, g, b, a] = rgbMatch
    return {
      raw,
      alpha: a === undefined ? 1 : clamp01(a.endsWith('%') ? parseFloat(a) / 100 : parseFloat(a)),
      linear: [r, g, b].map((c) => srgbGammaDecode(clamp01(parseFloat(c) / 255)))
    }
  }
  const oklchMatch = /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(str)
  if (oklchMatch) {
    const [, lRaw, cRaw, hRaw, aRaw] = oklchMatch
    const L = lRaw.endsWith('%') ? parseFloat(lRaw) / 100 : parseFloat(lRaw)
    const C = parseFloat(cRaw)
    const hRad = (parseFloat(hRaw) * Math.PI) / 180
    return {
      raw,
      alpha: aRaw === undefined ? 1 : clamp01(aRaw.endsWith('%') ? parseFloat(aRaw) / 100 : parseFloat(aRaw)),
      linear: oklabToLinearSrgb(L, C * Math.cos(hRad), C * Math.sin(hRad))
    }
  }
  const oklabMatch = /^oklab\(\s*([\d.]+%?)\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(str)
  if (oklabMatch) {
    const [, lRaw, aValRaw, bValRaw, aRaw] = oklabMatch
    const L = lRaw.endsWith('%') ? parseFloat(lRaw) / 100 : parseFloat(lRaw)
    return {
      raw,
      alpha: aRaw === undefined ? 1 : clamp01(aRaw.endsWith('%') ? parseFloat(aRaw) / 100 : parseFloat(aRaw)),
      linear: oklabToLinearSrgb(L, parseFloat(aValRaw), parseFloat(bValRaw))
    }
  }
  return null
}

export function measuredContrastRatio(fgRaw, bgRaw) {
  const fgEntry = parseComputedColorToEntry(fgRaw)
  const bgEntry = parseComputedColorToEntry(bgRaw)
  if (!fgEntry || !bgEntry) return null
  const fgLinear = resolvedLinear(fgEntry, bgEntry)
  const bgLinear = resolvedLinear(bgEntry, bgEntry)
  return contrastRatio(relativeLuminance(fgLinear), relativeLuminance(bgLinear))
}

// Tailwind v4's `ring-*` utilities always compose `box-shadow` from five comma-separated layers
// even when every one is a transparent/zero-geometry no-op -- `getComputedStyle()` never
// collapses that back to the literal string `'none'`. The only way to tell a genuine glow from
// Tailwind's own always-present zero-geometry layers is to measure each layer's real blur/spread
// radius and its colour's alpha: a layer paints visible pixels beyond the element's own border
// box only when (blur>0 or spread>0) AND alpha>0.
export function hasVisibleShadow(boxShadowRaw) {
  const str = (boxShadowRaw ?? '').trim()
  if (!str || str === 'none') return false
  for (const layer of str.split(/,(?![^(]*\))/)) {
    const trimmed = layer.trim().replace(/\s+inset$/, '').replace(/^inset\s+/, '')
    const geomMatch = /(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s*$/.exec(trimmed)
    if (!geomMatch) continue
    const [, , , blurStr, spreadStr] = geomMatch
    const blur = parseFloat(blurStr)
    const spread = parseFloat(spreadStr)
    if (blur <= 0 && spread <= 0) continue
    const colorRaw = trimmed.slice(0, geomMatch.index).trim()
    const entry = parseComputedColorToEntry(colorRaw)
    if (entry && entry.alpha > 0) return true
  }
  return false
}
