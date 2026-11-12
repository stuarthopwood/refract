// Parses every `.theme-*` block in globals.css into linear-sRGB token tables; shared by the contrast and display-profile checks.

import { readThemeCssSource } from './theme-css-source.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { addDerivedTokens } from './derived-tokens.mjs'
import { srgbGammaDecode, srgbGammaEncode } from './contrast-math.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const cssPath = path.join(repoRoot, 'src/renderer/styles/globals.css')
// The token regexes below are comment-unaware, so a `--token:` line inside a CSS comment would parse as live;
// fail loudly if stripping leaves an unbalanced marker (the strip swallowed real CSS or missed a comment).
function stripCssComments(source, label) {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const openCount = (source.match(/\/\*/g) || []).length
  const closeCount = (source.match(/\*\//g) || []).length
  if (openCount !== closeCount || stripped.includes('/*') || stripped.includes('*/')) {
    console.error(
      `${label}: unterminated or unbalanced CSS comment (found ${openCount} '/*' and ${closeCount} '*/') -- refusing to parse`,
    )
    process.exit(2)
  }
  return stripped
}
const css = stripCssComments(readThemeCssSource(), 'globals.css + styles/themes/*.css')

// OKLab -> linear sRGB, Bjorn Ottosson's reference matrices (https://bottosson.github.io/posts/oklab/).
function oklabToLinearSrgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b

  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_

  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ]
}

function oklchToLinearSrgb(L, C, Hdeg) {
  const hRad = (Hdeg * Math.PI) / 180
  const a = C * Math.cos(hRad)
  const b = C * Math.sin(hRad)
  return oklabToLinearSrgb(L, a, b)
}

function hexToLinearSrgb(hex) {
  let h = hex.slice(1)
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  return [srgbGammaDecode(r), srgbGammaDecode(g), srgbGammaDecode(b)]
}

// ---- parse every `.theme-<id> { ... }` block, generically (not hardcoded to today's two) -----

const THEME_BLOCK_RE = /\.theme-([a-z0-9-]+)\s*\{([^}]*)\}/g
const PROP_RE = /--([a-z0-9-]+):\s*([^;]+);/gi
const OKLCH_RE = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)%)?\s*\)$/i
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i
// Resolves one `var(--x)` reference at a time through any number of hops; `seen` guards a cycle so a malformed theme fails fast.
const VAR_RE = /^var\(\s*--([a-z0-9-]+)\s*\)$/i
// `-bg` tokens are `color-mix(in oklab, var(--x) Y%, transparent)`: scale --x's alpha by Y%, which is exact
// because every colour mixed with `transparent` today is fully opaque.
const COLOR_MIX_TRANSPARENT_RE = /^color-mix\(\s*in\s+[\w-]+\s*,\s*var\(\s*--([a-z0-9-]+)\s*\)\s+([\d.]+)%\s*,\s*transparent\s*\)$/i
const COLOR_MIX_WHITE_RE = /^color-mix\(\s*in\s+srgb\s*,\s*var\(\s*--([a-z0-9-]+)\s*\)\s+([\d.]+)%\s*,\s*white\s*\)$/i

// `seen` is threaded through this function's own recursion (resolveRawValue's is unrelated) so a mutual
// color-mix cycle returns undefined ("token missing") instead of overflowing the stack.
function parseColorLiteral(rawValue, rawProps, seen = new Set()) {
  const oklchMatch = rawValue.match(OKLCH_RE)
  if (oklchMatch) {
    const [, L, C, H, alphaPct] = oklchMatch
    return {
      raw: rawValue,
      alpha: alphaPct !== undefined ? Number(alphaPct) / 100 : 1,
      linear: oklchToLinearSrgb(Number(L), Number(C), Number(H)),
    }
  }
  const hexMatch = rawValue.match(HEX_RE)
  if (hexMatch) {
    return { raw: rawValue, alpha: 1, linear: hexToLinearSrgb(rawValue) }
  }
  const mixMatch = rawValue.match(COLOR_MIX_TRANSPARENT_RE)
  if (mixMatch) {
    const [, refName, pct] = mixMatch
    if (seen.has(refName)) return undefined
    seen.add(refName)
    const resolvedRef = resolveRawValue(refName, rawProps)
    if (resolvedRef === undefined) return undefined
    const base = parseColorLiteral(resolvedRef, rawProps, seen)
    if (base === undefined) return undefined
    return { raw: rawValue, alpha: base.alpha * (Number(pct) / 100), linear: base.linear }
  }
  // #1877: `color-mix(in srgb, var(--x) P%, white)` lightens an accent a step; mixing happens on gamma-encoded channels.
  const whiteMixMatch = rawValue.match(COLOR_MIX_WHITE_RE)
  if (whiteMixMatch) {
    const [, refName, pct] = whiteMixMatch
    if (seen.has(refName)) return undefined
    seen.add(refName)
    const resolvedRef = resolveRawValue(refName, rawProps)
    if (resolvedRef === undefined) return undefined
    const base = parseColorLiteral(resolvedRef, rawProps, seen)
    if (base === undefined) return undefined
    const p = Number(pct) / 100
    return { raw: rawValue, alpha: base.alpha, linear: base.linear.map((c) => srgbGammaDecode(srgbGammaEncode(c) * p + (1 - p))) }
  }
  return undefined
}

function resolveRawValue(name, rawProps, seen = new Set()) {
  const raw = rawProps[name]
  if (raw === undefined) return undefined
  const varMatch = raw.match(VAR_RE)
  if (!varMatch) return raw
  const refName = varMatch[1]
  if (seen.has(refName)) return undefined
  seen.add(refName)
  return resolveRawValue(refName, rawProps, seen)
}

// `Object.create(null)`: a `var(--constructor)` the block never defines would otherwise hit Object.prototype
// and throw instead of reporting "token missing".
const themes = Object.create(null)
// Alias detection matches the unresolved `var(--divider)` text, not values: `.theme-dark-high-contrast` sets
// --sidebar-border/--divider/--border to the same literal independently, which a value compare would misreport.
const sidebarBorderAliasesDivider = Object.create(null)

// #1472: per-element defaults live in one `:is(:root, .theme-*)` block; every theme starts from them.
const defaultProps = Object.create(null)
// Plain `:root` blocks hold theme-independent tokens (field-bg, elevated-edge, ...) that themes inherit; the `:is` block wins over them.
for (const match of css.matchAll(/(?:^|\n)[ \t]*:root\s*\{([^}]*)\}/g)) {
  for (const propMatch of match[1].matchAll(PROP_RE)) defaultProps[propMatch[1]] = propMatch[2].trim()
}
for (const match of css.matchAll(/:is\(:root,[^)]*\)\s*\{([^}]*)\}/g)) {
  for (const propMatch of match[1].matchAll(PROP_RE)) defaultProps[propMatch[1]] = propMatch[2].trim()
}

for (const blockMatch of css.matchAll(THEME_BLOCK_RE)) {
  const themeId = blockMatch[1]
  const body = blockMatch[2]
  const rawProps = Object.assign(Object.create(null), defaultProps)
  for (const propMatch of body.matchAll(PROP_RE)) {
    rawProps[propMatch[1]] = propMatch[2].trim()
  }
  const sidebarBorderAliasMatch = (rawProps['sidebar-border'] ?? '').match(VAR_RE)
  sidebarBorderAliasesDivider[themeId] = sidebarBorderAliasMatch?.[1] === 'divider'
  const props = Object.create(null)
  for (const name of Object.keys(rawProps)) {
    const rawValue = resolveRawValue(name, rawProps)
    if (rawValue === undefined) continue
    const parsed = parseColorLiteral(rawValue, rawProps)
    if (parsed) props[name] = parsed
    // Non-colour values (`transparent`, bare keywords) stay unparsed: no pair references them.
  }
  themes[themeId] = addDerivedTokens(props, rawProps)
}

export { css, cssPath, repoRoot, themes, sidebarBorderAliasesDivider }
