// Tokens that a theme block derives from two other tokens with `color-mix(in oklab, var(--a) P%, var(--b))`
// (spec 035: `--sidebar-right`, the midpoint of `--background` and `--sidebar`). check-theme-contrast.mjs
// only parses literals and `color-mix(..., transparent)`, so this resolves the two-token mix the way a
// browser does: interpolate the two opaque colours in OKLab, then convert back to linear sRGB.

const MIX_RE = /^color-mix\(\s*in\s+oklab\s*,\s*var\(\s*--([a-z0-9-]+)\s*\)\s+([\d.]+)%\s*,\s*var\(\s*--([a-z0-9-]+)\s*\)\s*\)$/i

function linearToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

function oklabToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ]
}

/** Adds every two-token `color-mix` declaration in `rawProps` to `props` (already-parsed tokens) and returns `props`. */
export function addDerivedTokens(props, rawProps) {
  for (const [name, raw] of Object.entries(rawProps)) {
    const match = raw.match(MIX_RE)
    if (!match) continue
    const first = props[match[1]]
    const second = props[match[3]]
    if (!first || !second || first.alpha !== 1 || second.alpha !== 1) continue
    const weight = Number(match[2]) / 100
    const a = linearToOklab(first.linear)
    const b = linearToOklab(second.linear)
    props[name] = { raw, alpha: 1, linear: oklabToLinear(a.map((v, i) => v * weight + b[i] * (1 - weight))) }
  }
  return props
}
