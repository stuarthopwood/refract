// Tokens that a theme block derives from two other tokens with `color-mix(in oklab|oklch, var(--a) P%?, var(--b) P%?)`
// (spec 035: `--sidebar-right`; spec 086: the secondary button hover). check-theme-contrast.mjs only parses literals
// and `color-mix(..., transparent)`, so this resolves the two-token mix the way a browser does: interpolate the
// two opaque colours in the named space (oklch takes the shorter hue arc), then convert back to linear sRGB.

const MIX_RE = /^color-mix\(\s*in\s+(oklab|oklch)\s*,\s*var\(\s*--([a-z0-9-]+)\s*\)(?:\s+([\d.]+)%)?\s*,\s*var\(\s*--([a-z0-9-]+)\s*\)(?:\s+([\d.]+)%)?\s*\)$/i

function oklabToOklch([L, a, b]) {
  return [L, Math.hypot(a, b), (Math.atan2(b, a) * 180) / Math.PI]
}

function oklchToOklab([L, C, h]) {
  const rad = (h * Math.PI) / 180
  return [L, C * Math.cos(rad), C * Math.sin(rad)]
}

// Premultiplied-alpha interpolation like CSS Color 4; returns the un-premultiplied OKLab colour.
function mixOklch(a, b, weight, alphaA, alphaB, alpha) {
  const [L1, C1, h1] = oklabToOklch(a)
  const [L2, C2, h2] = oklabToOklch(b)
  const EPS = 1e-4
  const hueA = C1 < EPS ? h2 : h1
  const hueB = C2 < EPS ? h1 : h2
  let delta = hueB - hueA
  if (delta > 180) delta -= 360
  else if (delta < -180) delta += 360
  const blend = (x, y) => (x * alphaA * weight + y * alphaB * (1 - weight)) / alpha
  return oklchToOklab([blend(L1, L2), blend(C1, C2), hueA + delta * (1 - weight)])
}

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
    const first = props[match[2]]
    const second = props[match[4]]
    if (!first || !second) continue
    const given1 = match[3] === undefined ? undefined : Number(match[3])
    const given2 = match[5] === undefined ? undefined : Number(match[5])
    const p1 = given1 ?? (given2 === undefined ? 50 : 100 - given2)
    const p2 = given2 ?? 100 - p1
    const weight = p1 / (p1 + p2)
    const a = linearToOklab(first.linear)
    const b = linearToOklab(second.linear)
    const alpha = first.alpha * weight + second.alpha * (1 - weight)
    if (alpha === 0) continue
    const mixed =
      match[1].toLowerCase() === 'oklch'
        ? mixOklch(a, b, weight, first.alpha, second.alpha, alpha)
        : a.map((v, i) => (v * first.alpha * weight + b[i] * second.alpha * (1 - weight)) / alpha)
    props[name] = { raw, alpha, linear: oklabToLinear(mixed) }
  }
  return props
}
