// Shared WCAG contrast / sRGB alpha-compositing primitives; one copy so the contrast checks can't drift apart.

export function clamp01(x) {
  return Math.min(1, Math.max(0, x))
}

export function srgbGammaDecode(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

// Linear -> gamma sRGB, for display only; the WCAG luminance formula takes linear values.
export function srgbGammaEncode(c) {
  const clamped = Math.min(1, Math.max(0, c))
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055
}

// Browsers alpha-composite in gamma-encoded sRGB, not linear light; a linear blend overstated contrast
// (`.theme-dark` `--border` read 4.01:1 but renders 1.53:1). Blend in gamma space, then decode to linear.
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

// Parses a computed colour string into `{ raw, alpha, linear }`. WebView2 reports `@theme`/`color-mix()`
// tokens as oklch()/oklab(), which convert straight to linear; only rgb()/rgba() bytes need `srgbGammaDecode`.
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

// Tailwind v4 `ring-*` always composes five box-shadow layers, never collapsing to 'none', so measure each:
// a layer paints beyond the border box only when (blur>0 or spread>0) AND alpha>0.
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
