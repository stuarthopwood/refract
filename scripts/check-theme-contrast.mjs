#!/usr/bin/env node
// Verifies every built-in theme's WCAG contrast ratios straight from the real CSS tokens
// (research.md decision 12, spec 007 T018, FR-008): parses every `.theme-<id> { ... }` block out
// of src/renderer/styles/globals.css, converts each `oklch(L C H [/ A%])` (and any literal hex)
// custom property to linear sRGB via the published OKLab<->linear-sRGB matrices (Bjorn Ottosson,
// https://bottosson.github.io/posts/oklab/), computes WCAG relative luminance and contrast ratio
// for every FR-007/FR-008 token pair this codebase actually renders, and prints a PASS/FAIL table.
// Usage: node scripts/check-theme-contrast.mjs
// Exits 1 if any pair fails its WCAG minimum, 0 if every pair across every theme passes.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const cssPath = path.join(repoRoot, 'src/renderer/styles/globals.css')
const css = readFileSync(cssPath, 'utf-8')

// ---- OKLCH / hex -> linear sRGB -----------------------------------------------------------

// OKLab -> linear sRGB, Bjorn Ottosson's published reference matrices.
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

function srgbGammaDecode(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function hexToLinearSrgb(hex) {
  let h = hex.slice(1)
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  return [srgbGammaDecode(r), srgbGammaDecode(g), srgbGammaDecode(b)]
}

// Linear sRGB -> gamma sRGB, for the hex debug column only (display, never fed back into the
// WCAG luminance formula, which operates on linear values directly).
function srgbGammaEncode(c) {
  const clamped = Math.min(1, Math.max(0, c))
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055
}

function linearToHex([r, g, b]) {
  const toByte = (c) => Math.round(srgbGammaEncode(c) * 255)
  return '#' + [r, g, b].map((c) => toByte(c).toString(16).padStart(2, '0')).join('')
}

// ---- parse every `.theme-<id> { ... }` block, generically (not hardcoded to today's two) -----

const THEME_BLOCK_RE = /\.theme-([a-z0-9-]+)\s*\{([^}]*)\}/g
const PROP_RE = /--([a-z0-9-]+):\s*([^;]+);/gi
const OKLCH_RE = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)%)?\s*\)$/i
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

const themes = {}

for (const blockMatch of css.matchAll(THEME_BLOCK_RE)) {
  const themeId = blockMatch[1]
  const body = blockMatch[2]
  const props = {}
  for (const propMatch of body.matchAll(PROP_RE)) {
    const name = propMatch[1]
    const rawValue = propMatch[2].trim()
    const oklchMatch = rawValue.match(OKLCH_RE)
    const hexMatch = rawValue.match(HEX_RE)
    if (oklchMatch) {
      const [, L, C, H, alphaPct] = oklchMatch
      props[name] = {
        raw: rawValue,
        alpha: alphaPct !== undefined ? Number(alphaPct) / 100 : 1,
        linear: oklchToLinearSrgb(Number(L), Number(C), Number(H)),
      }
    } else if (hexMatch) {
      props[name] = { raw: rawValue, alpha: 1, linear: hexToLinearSrgb(rawValue) }
    }
    // Non-colour values (`transparent`, bare keywords) are intentionally left unparsed -- no
    // pair below references them as a colour operand.
  }
  themes[themeId] = props
}

// ---- WCAG relative luminance / contrast ratio -------------------------------------------------

function clamp01(x) {
  return Math.min(1, Math.max(0, x))
}

// Alpha-composite `fg` (with its own alpha) over opaque `bg`, in linear space, then clamp --
// approximates what the browser paints for the handful of semi-transparent tokens (e.g.
// `--border`) this file defines.
function compositeOverLinear(fg, bg) {
  return fg.linear.map((c, i) => clamp01(fg.alpha * c + (1 - fg.alpha) * bg.linear[i]))
}

function relativeLuminance([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(lumA, lumB) {
  const lighter = Math.max(lumA, lumB)
  const darker = Math.min(lumA, lumB)
  return (lighter + 0.05) / (darker + 0.05)
}

function resolvedLinear(propEntry, backdropEntry) {
  if (propEntry.alpha >= 1) return propEntry.linear.map(clamp01)
  return compositeOverLinear(propEntry, backdropEntry)
}

// ---- FR-007/FR-008 token pairs actually rendered by this codebase ----------------------------
// `min: 4.5` = WCAG AA body/UI text; `min: 3` = WCAG AA large text and non-text UI components
// (focus rings, borders, scrollbar thumbs, status icons used without accompanying text).

const PAIRS = [
  { fg: 'foreground', bg: 'background', min: 4.5 },
  { fg: 'card-foreground', bg: 'card', min: 4.5 },
  { fg: 'popover-foreground', bg: 'popover', min: 4.5 },
  { fg: 'primary-foreground', bg: 'primary', min: 4.5 },
  { fg: 'secondary-foreground', bg: 'secondary', min: 4.5 },
  { fg: 'muted-foreground', bg: 'background', min: 4.5 },
  { fg: 'accent-foreground', bg: 'accent', min: 4.5 },
  { fg: 'destructive-foreground', bg: 'destructive', min: 4.5 },
  { fg: 'chat-foreground', bg: 'background', min: 4.5 },
  { fg: 'state-working-foreground', bg: 'state-working', min: 4.5 },
  { fg: 'state-needs-you-foreground', bg: 'state-needs-you', min: 4.5 },
  { fg: 'state-stopped-foreground', bg: 'state-stopped', min: 4.5 },
  { fg: 'ring', bg: 'background', min: 3 },
  { fg: 'border', bg: 'background', min: 3 },
  { fg: 'scrollbar-thumb', bg: 'background', min: 3 },
  { fg: 'active-indicator', bg: 'background', min: 3 },
  { fg: 'destructive', bg: 'background', min: 3 },
  { fg: 'state-working', bg: 'background', min: 3 },
  { fg: 'state-idle', bg: 'background', min: 3 },
  { fg: 'state-needs-you', bg: 'background', min: 3 },
  { fg: 'state-stopped', bg: 'background', min: 3 },
]

// ---- run every pair against every parsed theme ------------------------------------------------

let failCount = 0
let checkedCount = 0
const rows = []

for (const [themeId, props] of Object.entries(themes)) {
  for (const { fg, bg, min } of PAIRS) {
    const fgEntry = props[fg]
    const bgEntry = props[bg]
    if (!fgEntry || !bgEntry) {
      rows.push({ themeId, fg, bg, min, ratio: null, pass: null, note: 'token missing' })
      continue
    }
    const fgLinear = resolvedLinear(fgEntry, bgEntry)
    const bgLinear = resolvedLinear(bgEntry, bgEntry)
    const ratio = contrastRatio(relativeLuminance(fgLinear), relativeLuminance(bgLinear))
    const pass = ratio >= min
    checkedCount++
    if (!pass) failCount++
    rows.push({
      themeId,
      fg,
      bg,
      min,
      ratio,
      pass,
      fgHex: linearToHex(fgLinear),
      bgHex: linearToHex(bgLinear),
    })
  }
}

// ---- print the table ---------------------------------------------------------------------

const header = ['theme', 'pair', 'ratio', 'min', 'result']
const widths = [18, 38, 8, 5, 6]
function row(cells) {
  return cells.map((c, i) => String(c).padEnd(widths[i])).join(' ')
}
console.log(row(header))
console.log(row(widths.map((w) => '-'.repeat(w))))

for (const r of rows) {
  const pairLabel = `${r.fg} / ${r.bg}`
  if (r.ratio === null) {
    console.log(row([r.themeId, pairLabel, 'n/a', r.min, 'FAIL']) + `  (${r.note}: ${r.fg} or ${r.bg} not found)`)
    continue
  }
  const result = r.pass ? 'PASS' : 'FAIL'
  console.log(row([r.themeId, pairLabel, r.ratio.toFixed(2) + ':1', r.min, result]) + `  (${r.fgHex} on ${r.bgHex})`)
}

console.log('')
if (checkedCount === 0) {
  console.log(`no .theme-* blocks or token pairs resolved in ${path.relative(repoRoot, cssPath)}`)
  process.exit(2)
} else if (failCount > 0) {
  console.log(`${failCount} of ${checkedCount} pair${checkedCount === 1 ? '' : 's'} FAILED their WCAG minimum`)
  process.exit(1)
} else {
  console.log(`all ${checkedCount} pairs across ${Object.keys(themes).length} theme${Object.keys(themes).length === 1 ? '' : 's'} PASS`)
  process.exit(0)
}
