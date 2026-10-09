#!/usr/bin/env node
// Verifies every built-in theme's WCAG contrast ratios straight from the real CSS tokens
// (research.md decision 12, spec 007 T018, FR-008): parses every `.theme-<id> { ... }` block out
// of src/renderer/styles/globals.css, converts each `oklch(L C H [/ A%])` (and any literal hex)
// custom property to linear sRGB via the published OKLab<->linear-sRGB matrices (Bjorn Ottosson,
// https://bottosson.github.io/posts/oklab/), computes WCAG relative luminance and contrast ratio
// for every FR-007/FR-008 token pair this codebase actually renders, and prints a PASS/FAIL table.
// Usage: node scripts/check-theme-contrast.mjs
// Exits 1 if any pair fails its WCAG minimum, 0 if every pair across every theme passes.
// Methodology note: several of this app's `oklch()` severity/accent colours are outside the
// sRGB gamut (their converted linear-sRGB channel is briefly >1 before the per-channel clamp
// below), so this script clips them the same way a non-wide-gamut sRGB display does. A real
// wide-gamut (P3) Chromium display may render those exact pixels slightly differently, so their
// true on-screen luminance can differ a little from the clipped value this script computes.
// Not a bug to fix now -- noted so a future pass can switch to CSS Color 4 chroma-reduction
// gamut mapping if that gap ever matters in practice.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const cssPath = path.join(repoRoot, 'src/renderer/styles/globals.css')
// A11y/quality-gate remediation (HIGH): THEME_BLOCK_RE/PROP_RE below match raw text with no
// comment-awareness, so a `--token: value;`-shaped line sitting INSIDE a `/* ... */` CSS
// comment -- whether commented out on purpose or swallowed by an editing accident that dropped
// a comment's closing `*/` -- would silently parse as if it were a live declaration. Strip every
// `/* ... */` block before any matching, and fail loudly (not silently) if stripping still
// leaves an unbalanced or unterminated comment marker behind, which would otherwise mean the
// strip itself swallowed real CSS or missed a real comment.
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
const css = stripCssComments(readFileSync(cssPath, 'utf-8'), path.relative(repoRoot, cssPath))

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
// #550 (three-layer tokens): a component token may now read `var(--some-role)` instead of a
// literal colour (layer 3 defaulting to layer 2 -- `--card: var(--surface-1)`, `--state-working:
// var(--severity-success)`, and so on). This resolves one named reference at a time, recursing
// through however many `var()` hops a theme uses, with a `seen` set guarding against a cycle
// (two tokens pointing at each other) so a malformed theme fails fast instead of looping forever.
const VAR_RE = /^var\(\s*--([a-z0-9-]+)\s*\)$/i
// #550 item 2 (tinted severity backgrounds): a `-bg` token is written as `color-mix(in oklab,
// var(--x) Y%, transparent)` -- a translucent variant of an existing opaque severity token,
// expressed as a mix rather than a second literal so each theme's own hue carries through
// automatically. Resolves `--x` through the same `var()` chain as `resolveRawValue` above, then
// through this same colour parser, and scales ITS alpha by `Y%` -- correct because every colour
// this mixes with `transparent` today is itself fully opaque (alpha 1), so alpha multiplication,
// not blending, is the exact operation `color-mix(..., transparent)` performs.
const COLOR_MIX_TRANSPARENT_RE = /^color-mix\(\s*in\s+[\w-]+\s*,\s*var\(\s*--([a-z0-9-]+)\s*\)\s+([\d.]+)%\s*,\s*transparent\s*\)$/i

// Security review (LOW): `color-mix(...)` can reference another `color-mix(...)` token (e.g. a
// theme writing `--a: color-mix(in oklab, var(--b) 50%, transparent)` and `--b` pointing back at
// `--a` the same way) -- `resolveRawValue`'s own `seen` set only guards a plain `var()` chain, a
// fresh one each recursive call here, so a mutual color-mix cycle would recurse forever and
// crash with a stack overflow instead of failing cleanly. `seen` below is threaded through this
// function's own recursive call (not `resolveRawValue`'s, which is unrelated) and returns
// `undefined` (treated as "token missing" by every caller) the moment a name repeats.
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

// `Object.create(null)` rather than `{}` for every one of these token maps: a theme block that
// writes `var(--constructor)` (or another `Object.prototype` name) which the block itself never
// defines would otherwise return a function from a plain-object lookup, and `.match` on it
// throws instead of reporting "token missing". Dev-only tool reading a trusted repo file, so
// this is robustness, not an exploit.
const themes = Object.create(null)
// Captured alongside `themes`: whether a preset's own `--sidebar-border` is written as a `var()`
// reference to `--divider` specifically -- matched via `VAR_RE` (tolerates `var( --divider )`
// spacing, unlike a bare string-equality check), not a resolved-value comparison, because
// `.theme-dark-high-contrast` happens to set `--sidebar-border`/`--divider`/`--border` to the
// SAME coincidental value independently (all three equal `oklch(0.6 0 0)` there without one
// aliasing another), which a resolved-value comparison would misreport as an alias.
const sidebarBorderAliasesDivider = Object.create(null)

for (const blockMatch of css.matchAll(THEME_BLOCK_RE)) {
  const themeId = blockMatch[1]
  const body = blockMatch[2]
  const rawProps = Object.create(null)
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
    // Non-colour values (`transparent`, bare keywords) are intentionally left unparsed -- no
    // pair below references them as a colour operand.
  }
  themes[themeId] = props
}

// A theme registered in `src/shared/themes.ts`'s `ThemeId` union with no matching `.theme-<id>`
// block above would otherwise just never appear in `themes` -- the two loops below only ever
// iterate `Object.entries(themes)`, so a deleted or renamed CSS block would silently vanish
// from the table and the run would still print "all N pairs across (one fewer) themes PASS" and
// exit 0. Parse the `ThemeId` union directly (the same source `src/main`/the renderer import
// for real) and fail loudly for any id it declares that this file never defined a block for.
// The union may wrap onto several lines (no trailing `;` -- TypeScript ASI), so this matches up
// to the next blank line, the next `export`, or an explicit `;`, whichever comes first; if
// nothing matches, or no ids come out, that is itself a hard failure (exit 2), not a silent
// `declaredThemeIds = []` that would quietly turn off both this check and the one below it.
const themesTsPath = path.join(repoRoot, 'src/shared/themes.ts')
const themesTs = readFileSync(themesTsPath, 'utf-8')
const THEME_ID_UNION_RE = /export type ThemeId\s*=\s*([\s\S]+?)(?:\r?\n\s*\r?\n|\r?\n\s*\/\/|\r?\nexport|;)/
const themeIdUnionMatch = themesTs.match(THEME_ID_UNION_RE)
const declaredThemeIds = themeIdUnionMatch
  ? [...themeIdUnionMatch[1].matchAll(/['"]([a-z0-9-]+)['"]/g)].map((m) => m[1])
  : []
if (declaredThemeIds.length === 0) {
  console.error(`could not parse ThemeId union in ${path.relative(repoRoot, themesTsPath)}`)
  process.exit(2)
}
const missingThemeBlocks = declaredThemeIds.filter((id) => !(id in themes))

// The exact bug that caused this PR's first two gate failures -- `themes.ts`'s `swatch`/
// `titleBarOverlay.color` silently drifting from the theme's own `.theme-<id>` `--background`
// -- was only ever caught by a human re-reading two files side by side; nothing in this script
// checked it. Parse every entry's `id`, `swatch`, and `titleBarOverlay.color` out of the same
// `themesTs` source text already read above. The tempered `(?:(?!id:)[\s\S])*?` gaps (not a
// plain `[\s\S]*?`) stop each entry's own match at the next `id:`, so a theme entry missing its
// `swatch` or `titleBarOverlay` cannot silently read the NEXT entry's values instead -- it just
// fails to match, which the count check below turns into a hard failure.
const THEME_METADATA_RE = /id:\s*'([a-z0-9-]+)'(?:(?!id:)[\s\S])*?swatch:\s*'(#[0-9a-fA-F]{3,8})'(?:(?!id:)[\s\S])*?titleBarOverlay:\s*\{\s*color:\s*'(#[0-9a-fA-F]{3,8})'/g
const themeMetadata = Object.create(null)
for (const m of themesTs.matchAll(THEME_METADATA_RE)) {
  themeMetadata[m[1]] = { swatch: m[2].toLowerCase(), titleBarOverlayColor: m[3].toLowerCase() }
}
if (Object.keys(themeMetadata).length !== declaredThemeIds.length) {
  console.error(
    `parsed ${Object.keys(themeMetadata).length} theme metadata entries out of ${declaredThemeIds.length} declared ThemeId(s) in ${path.relative(repoRoot, themesTsPath)} -- THEME_METADATA_RE failed to match at least one entry`,
  )
  process.exit(2)
}

// Spec 012 (brand watermark, research.md decision 13): `--watermark-opacity` is
// theme-independent, declared once in `:root`, not inside any `.theme-<id>` block above.
const ROOT_BLOCK_RE = /:root\s*\{([^}]*)\}/
const rootMatch = css.match(ROOT_BLOCK_RE)
const watermarkOpacityMatch = rootMatch ? rootMatch[1].match(/--watermark-opacity:\s*([\d.]+)\s*;/) : null
const watermarkOpacity = watermarkOpacityMatch ? Number(watermarkOpacityMatch[1]) : null

// ---- WCAG relative luminance / contrast ratio -------------------------------------------------

function clamp01(x) {
  return Math.min(1, Math.max(0, x))
}

// Quality-gate remediation (HIGH, corroborated by code-reviewer/test-reviewer/accessibility-
// auditor): browsers alpha-composite in gamma-encoded sRGB space, not linear light -- blending
// in linear space (the old behaviour here) understated how much a semi-transparent token lets
// the backdrop show through. A reviewer independently confirmed with node that `.theme-dark`'s
// `--border` (16% alpha) was reported 4.01:1 by the old linear blend but is actually only
// 1.53:1 as really rendered. Fix: gamma-encode both operands, blend in that gamma space (what
// the compositor does), then gamma-decode the blended result back to linear before computing
// WCAG relative luminance.
function compositeOverLinear(fg, bg) {
  return fg.linear.map((c, i) => {
    const fgGamma = srgbGammaEncode(clamp01(c))
    const bgGamma = srgbGammaEncode(clamp01(bg.linear[i]))
    return srgbGammaDecode(clamp01(fg.alpha * fgGamma + (1 - fg.alpha) * bgGamma))
  })
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
// (focus rings, control-edge borders, scrollbar thumbs, status icons used without accompanying
// text). `--divider` is NOT a control edge (#550: it is the soft decorative edge, read by no
// component yet except where it IS a real rendered fill -- see DIVIDER_PAIRS's own comment
// below). `--border` IS a control edge in every theme in this remediated cut (Dark/HC keep
// rendering every un-migrated `border-border` call site with it, unchanged; Obsidian's own
// `--border` is tuned to the same floor) -- checked here, same as `--border-strong`, its alias.

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
  { fg: 'scrollbar-thumb', bg: 'background', min: 3 },
  { fg: 'active-indicator', bg: 'background', min: 3 },
  { fg: 'destructive', bg: 'background', min: 3 },
  { fg: 'state-working', bg: 'background', min: 3 },
  { fg: 'state-idle', bg: 'background', min: 3 },
  { fg: 'state-needs-you', bg: 'background', min: 3 },
  { fg: 'state-stopped', bg: 'background', min: 3 },
  // These real component-boundary pairs were missing and measure as genuine failures --
  // `--input` (the border of every Input/Textarea/Select/outline-Toggle/outline-Button,
  // including the Appearance section's own Cancel button).
  { fg: 'input', bg: 'background', min: 3 },
  // #550 (theme foundation, palette v2): the control-edge tokens (`--border`, the one every
  // un-migrated component actually renders with, and `--border-strong`, its forward-looking
  // alias -- #550's own divider-versus-control-edge rule) and the new semantic roles the
  // contrast script must learn or it would silently pass a theme that never defines them (the
  // 'token missing' path below still fires if any of these are absent).
  { fg: 'border', bg: 'background', min: 3 },
  { fg: 'border', bg: 'card', min: 3 },
  { fg: 'border', bg: 'popover', min: 3 },
  { fg: 'border', bg: 'muted', min: 3 },
  { fg: 'border-strong', bg: 'background', min: 3 },
  { fg: 'border-strong', bg: 'card', min: 3 },
  { fg: 'border-strong', bg: 'popover', min: 3 },
  { fg: 'border-strong', bg: 'muted', min: 3 },
  { fg: 'accent-text', bg: 'background', min: 4.5 },
  { fg: 'accent-text', bg: 'card', min: 4.5 },
  { fg: 'accent-text', bg: 'popover', min: 4.5 },
  // TODO(#579): `accent-text` on `surface-hover` (the muted/accent hover fill) measures only
  // 4.00:1 in Dark and 4.28:1 in Obsidian -- under the 4.5:1 text floor. Not added as a PAIRS
  // entry (it would fail both themes today); no component reads `--accent-text` yet, so nothing
  // renders incorrectly. Before #579 migrates a link/text colour onto a hover row, either
  // lighten `accent-text` further (it already has margin to spare against background/card/
  // popover) or add this pair here once it passes.
  { fg: 'severity-success', bg: 'background', min: 3 },
  { fg: 'severity-success', bg: 'card', min: 3 },
  { fg: 'severity-success', bg: 'popover', min: 3 },
  { fg: 'severity-warning', bg: 'background', min: 3 },
  { fg: 'severity-warning', bg: 'card', min: 3 },
  { fg: 'severity-warning', bg: 'popover', min: 3 },
  { fg: 'severity-error', bg: 'background', min: 3 },
  { fg: 'severity-error', bg: 'card', min: 3 },
  { fg: 'severity-error', bg: 'popover', min: 3 },
  { fg: 'severity-info', bg: 'background', min: 3 },
  { fg: 'severity-info', bg: 'card', min: 3 },
  { fg: 'severity-info', bg: 'popover', min: 3 },
  // `muted-foreground` and `destructive` are rendered as actual BODY TEXT (code-block/diff-path
  // headers, inactive tab labels, notice text, dropdown-menu destructive items, alert
  // descriptions), not just against the page `--background` the two pre-existing pairs above
  // already covered -- against `--muted`/`--accent` (the shadcn "neutral highlight"
  // hover/selected fills text sits on) and `--card`/`--popover` (dialog/menu surfaces)
  // respectively.
  { fg: 'muted-foreground', bg: 'muted', min: 4.5 },
  { fg: 'muted-foreground', bg: 'accent', min: 4.5 },
  { fg: 'muted-foreground', bg: 'card', min: 4.5 },
  { fg: 'muted-foreground', bg: 'popover', min: 4.5 },
  { fg: 'muted-foreground', bg: 'surface-hover', min: 4.5 },
  { fg: 'destructive', bg: 'card', min: 4.5 },
  { fg: 'destructive', bg: 'popover', min: 4.5 },
  // Issue #601: `CheckRow.tsx`'s failed/warning hint text (`text-destructive`/
  // `text-state-needs-you`) used to sit on `--card` (the readiness screen's own grey box).
  // Only `destructive`/`card` had a 4.5:1 pair there already (just above); `state-needs-you`/
  // `card` was never gated at 4.5:1 anywhere. Both tokens were gated against `--background`
  // only at the 3:1 non-text floor (the pairs above, shared with the icon-only use of these
  // same tokens). Removing the box puts the hint text directly on `--background`, so both now
  // need their own real 4.5:1 text pair there too.
  // Issue #533: the composer's new empty-state hint overlay (icons plus "for commands" /
  // "Markdown supported" text, `MessageInput.tsx`) renders `text-muted-foreground` directly on
  // `--composer-background`, the composer field's own distinct per-theme fill (NOT the page
  // `--background` the `muted-foreground`/`background` pair above already covers) -- the first
  // component to put real text on this token, so it needs its own pair.
  { fg: 'muted-foreground', bg: 'composer-background', min: 4.5 },
  { fg: 'destructive', bg: 'background', min: 4.5 },
  { fg: 'state-needs-you', bg: 'background', min: 4.5 },
  // `--input`/`--ring`, the control-edge tokens every dialog footer's outline Cancel button and
  // every focus ring actually render, checked only against `--background` before -- dialogs
  // and menus sit on `--popover`/`--muted`, not the page.
  { fg: 'input', bg: 'popover', min: 3 },
  { fg: 'input', bg: 'muted', min: 3 },
  { fg: 'ring', bg: 'popover', min: 3 },
  { fg: 'ring', bg: 'muted', min: 3 },
  // Agent-working spinner (issue #612, #616 review round 4): Stuart's decision -- the brand
  // violet is now a per-theme Layer 3 component token (`--agent-spinner-core`, same value in
  // every theme today, declared in each `.theme-*` block in globals.css), not a fixed colour.
  // Checked against every surface the mark actually renders on: the session list (`--sidebar`),
  // that same row selected or hovered (`--sidebar-accent`, `SessionList.tsx` -- the icon is the
  // only visible status cue there, the "Working" text is `sr-only`), the chat header
  // (`--background`), and the session details hover card (`--popover`, `hover-card.tsx` -- NOT
  // `--card`, corrected in round 5 after the A11y gate found the real surface).
  // Quality-gate remediation (A11y HIGH, round 5): `--sidebar-accent` was missing from this list
  // entirely and the original `#864DD6` measured under 3:1 against it in every theme (2.91 Dark
  // / 2.54 Obsidian / 2.99 Dark HC); Stuart's `#9A68E4` fix (see `.theme-dark`'s own comment)
  // clears it everywhere (3.94 / 3.43 / 4.05). `--card` is kept as a fourth pair even though
  // `--popover` is the real card surface, since `--card` happens to equal `--popover` in Dark
  // and Dark HC (not in Obsidian) and nothing currently regresses by also checking it.
  { fg: 'agent-spinner-core', bg: 'sidebar', min: 3 },
  { fg: 'agent-spinner-core', bg: 'sidebar-accent', min: 3 },
  { fg: 'agent-spinner-core', bg: 'card', min: 3 },
  { fg: 'agent-spinner-core', bg: 'popover', min: 3 },
  { fg: 'agent-spinner-core', bg: 'background', min: 3 },
]

// The OTHER edge class -- soft decorative dividers (panes, rows, headers, sections), now named
// `--divider` (never `--border`, which stays a real control edge everywhere in this cut -- see
// PAIRS above). Not required by WCAG 1.4.11 because a decorative divider never identifies a
// control, so this carries no contrast floor in any theme (checked for presence only -- a
// theme missing the token still fails below) EXCEPT where a preset's own `--sidebar-border`
// aliases `--divider` (Obsidian does; Dark/HC keep their own, unrelated, pre-existing
// `--sidebar-border` value, untouched by this story) -- that alias IS a real rendered fill
// (`hover:bg-sidebar-border` in SessionList.tsx/ProfileItem.tsx with `--muted-foreground`
// text/icon on top), so it gets a real floor from a dedicated check below DIVIDER_PAIRS's own
// loop, scoped dynamically to whichever preset(s) actually make that choice.
// The design doc's own stricter high-contrast treatment ("soft dividers switched off, every edge
// reaches 4.5:1 text / 7:1") is real but NOT delivered in this story for Dark (high contrast):
// doing so would mean raising that preset's existing, live `--input`/`--ring`/`--muted`/
// `--accent` values, which this remediated cut's whole point is to avoid changing. Deferred to
// #552, which owns that preset's actual design; `.theme-dark-high-contrast`'s own CSS comment
// records the same deferral.
const DIVIDER_PAIRS = [
  { fg: 'divider', bg: 'background' },
  { fg: 'divider', bg: 'card' },
  { fg: 'divider', bg: 'popover' },
  { fg: 'divider', bg: 'muted' },
  { fg: 'divider', bg: 'sidebar' },
]

// ---- run every pair against every parsed theme ------------------------------------------------

let failCount = 0
let checkedCount = 0
const rows = []

for (const id of missingThemeBlocks) {
  checkedCount++
  failCount++
  rows.push({
    themeId: id,
    fg: '(entire theme)',
    bg: `.theme-${id}`,
    min: 'n/a',
    ratio: null,
    pass: false,
    note: `'${id}' is declared in src/shared/themes.ts's ThemeId union but has no .theme-${id} block in globals.css`,
  })
}

for (const id of declaredThemeIds) {
  if (!(id in themes)) continue // already reported as a missing block above
  checkedCount++
  const meta = themeMetadata[id]
  if (!meta) {
    failCount++
    rows.push({
      themeId: id,
      fg: 'themes.ts swatch/titleBarOverlay',
      bg: `.theme-${id} --background`,
      min: 'n/a',
      ratio: null,
      pass: false,
      note: `could not parse 'swatch'/'titleBarOverlay.color' for '${id}' out of src/shared/themes.ts`,
    })
    continue
  }
  const bg = themes[id].background
  if (!bg) {
    failCount++
    rows.push({
      themeId: id,
      fg: 'themes.ts swatch/titleBarOverlay',
      bg: `.theme-${id} --background`,
      min: 'n/a',
      ratio: null,
      pass: false,
      note: `'${id}' has no --background token in globals.css to compare against`,
    })
    continue
  }
  const actualBgHex = linearToHex(bg.linear)
  const mismatches = []
  if (meta.swatch !== actualBgHex) mismatches.push(`swatch '${meta.swatch}' != --background '${actualBgHex}'`)
  if (meta.titleBarOverlayColor !== actualBgHex) mismatches.push(`titleBarOverlay.color '${meta.titleBarOverlayColor}' != --background '${actualBgHex}'`)
  if (mismatches.length > 0) {
    failCount++
    rows.push({
      themeId: id,
      fg: 'themes.ts swatch/titleBarOverlay',
      bg: `.theme-${id} --background`,
      min: 'n/a',
      ratio: null,
      pass: false,
      note: mismatches.join('; '),
    })
  }
}

for (const [themeId, props] of Object.entries(themes)) {
  for (const { fg, bg, min } of PAIRS) {
    const fgEntry = props[fg]
    const bgEntry = props[bg]
    if (!fgEntry || !bgEntry) {
      checkedCount++
      failCount++
      rows.push({ themeId, fg, bg, min, ratio: null, pass: false, note: 'token missing' })
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

// Decorative-divider pairs -- exempt from any floor in every theme (deferred, see
// DIVIDER_PAIRS's own comment above), still failing if the token is missing outright, same as
// every other pair above.
for (const [themeId, props] of Object.entries(themes)) {
  for (const { fg, bg } of DIVIDER_PAIRS) {
    const fgEntry = props[fg]
    const bgEntry = props[bg]
    if (!fgEntry || !bgEntry) {
      checkedCount++
      failCount++
      rows.push({ themeId, fg, bg, min: 'soft', ratio: null, pass: false, note: 'token missing' })
      continue
    }
    const fgLinear = resolvedLinear(fgEntry, bgEntry)
    const bgLinear = resolvedLinear(bgEntry, bgEntry)
    const ratio = contrastRatio(relativeLuminance(fgLinear), relativeLuminance(bgLinear))
    checkedCount++
    rows.push({
      themeId,
      fg,
      bg,
      min: 'soft',
      ratio,
      pass: true,
      fgHex: linearToHex(fgLinear),
      bgHex: linearToHex(bgLinear),
      note: 'decorative divider, no floor (deferred, see #552)',
    })
  }
}

// Where a preset's own `--sidebar-border` is written as the literal text `var(--divider)`
// (`sidebarBorderAliasesDivider`, captured above from the UNRESOLVED source text -- Obsidian
// does; `.theme-dark`/`.theme-dark-high-contrast` do NOT, their own `--sidebar-border` is a
// pre-existing, unrelated value, untouched by this story, even though `.theme-dark-high-
// contrast`'s happens to equal `--border`/`--divider`'s value by coincidence, not by alias) --
// that alias IS a real rendered fill (`hover:bg-sidebar-border` in
// SessionList.tsx/ProfileItem.tsx), so it gets a real 4.5:1 floor against `--muted-foreground`,
// the text/icon colour rendered on top.
for (const [themeId, props] of Object.entries(themes)) {
  if (!sidebarBorderAliasesDivider[themeId]) continue
  const sidebarBorder = props['sidebar-border']
  const mutedForeground = props['muted-foreground']
  checkedCount++
  if (!sidebarBorder || !mutedForeground) {
    failCount++
    rows.push({ themeId, fg: 'muted-foreground', bg: 'sidebar-border', min: 4.5, ratio: null, pass: false, note: 'token missing' })
    continue
  }
  const fgLinear = resolvedLinear(mutedForeground, sidebarBorder)
  const bgLinear = resolvedLinear(sidebarBorder, sidebarBorder)
  const ratio = contrastRatio(relativeLuminance(fgLinear), relativeLuminance(bgLinear))
  const pass = ratio >= 4.5
  if (!pass) failCount++
  rows.push({
    themeId,
    fg: 'muted-foreground',
    bg: 'sidebar-border',
    min: 4.5,
    ratio,
    pass,
    fgHex: linearToHex(fgLinear),
    bgHex: linearToHex(bgLinear),
  })
}

// #550 item 3 (surface ladder): design intent is "background, then surface 1, 2, 3, each a step
// lighter" -- nothing checked that ordering, so a future edit could make a surface darker than
// the one before it (or collapse two into the same value, which Dark/HC already do on purpose
// today -- `--surface-1` equals `--surface-2`, see `.theme-dark`'s own comment) without this
// script noticing. Fails if luminance strictly DECREASES anywhere along the ladder; equal
// adjacent steps are allowed.
const SURFACE_LADDER = ['background', 'surface-1', 'surface-2', 'surface-3']
for (const [themeId, props] of Object.entries(themes)) {
  let prevName, prevLum
  for (const name of SURFACE_LADDER) {
    const entry = props[name]
    if (!entry) {
      checkedCount++
      failCount++
      rows.push({ themeId, fg: name, bg: '(surface ladder)', min: 'order', ratio: null, pass: false, note: 'token missing' })
      prevName = undefined
      continue
    }
    const linear = resolvedLinear(entry, entry)
    const lum = relativeLuminance(linear)
    if (prevName !== undefined) {
      checkedCount++
      const pass = lum >= prevLum - 1e-9
      if (!pass) failCount++
      rows.push({
        themeId,
        fg: name,
        bg: prevName,
        min: 'order',
        ratio: contrastRatio(lum, prevLum),
        pass,
        fgHex: linearToHex(linear),
        bgHex: linearToHex(resolvedLinear(props[prevName], props[prevName])),
        note: pass ? undefined : `'--${name}' is darker than '--${prevName}' -- the surface ladder must not get darker`,
      })
    }
    prevName = name
    prevLum = lum
  }
}

// #550 item 2 (tinted severity backgrounds): each `--severity-{success,warning,error,info}-bg`
// is a translucent tint of its opaque severity colour (globals.css's own comment records the
// chosen alpha and why). Checked the way the design is actually used -- a severity banner's own
// coloured text directly on its own tint, AND plain `--foreground` on that same tint (the more
// common case: a neutral-text notice with a coloured tint background) -- composited over
// `--background`, `--card` AND `--popover` (dialog.tsx, alert-dialog.tsx, sheet.tsx,
// dropdown-menu.tsx, popover.tsx and select.tsx all render on `bg-popover`, not `--card`), since
// the tint's OWN alpha means its final rendered colour depends on what real surface it sits on.
// Deliberately NOT `--muted`: no component puts a severity banner there today, and Obsidian's
// severity colours cannot clear 4.5:1 against a `--muted` tint at any alpha that still clears
// 4.5:1 against `--popover` too (the two surfaces pull in opposite directions) -- if a future
// change puts a severity banner on `--muted`, add it here and re-tune, don't assume it passes.
const SEVERITIES = ['success', 'warning', 'error', 'info']
const SEVERITY_BACKDROPS = ['background', 'card', 'popover']
for (const [themeId, props] of Object.entries(themes)) {
  const foreground = props['foreground']
  for (const severity of SEVERITIES) {
    const severityEntry = props[`severity-${severity}`]
    const tintEntry = props[`severity-${severity}-bg`]
    for (const backdropName of SEVERITY_BACKDROPS) {
      const backdropEntry = props[backdropName]
      if (!severityEntry || !tintEntry || !backdropEntry || !foreground) {
        checkedCount += 2
        failCount += 2
        rows.push({
          themeId,
          fg: `severity-${severity}`,
          bg: `severity-${severity}-bg on ${backdropName}`,
          min: 4.5,
          ratio: null,
          pass: false,
          note: 'token missing',
        })
        rows.push({
          themeId,
          fg: 'foreground',
          bg: `severity-${severity}-bg on ${backdropName}`,
          min: 4.5,
          ratio: null,
          pass: false,
          note: 'token missing',
        })
        continue
      }
      checkedCount++
      const tintLinear = resolvedLinear(tintEntry, backdropEntry)
      const tintLum = relativeLuminance(tintLinear)
      const tintBackdropEntry = { raw: `severity-${severity}-bg on ${backdropName}`, alpha: 1, linear: tintLinear }
      const severityOnTintRatio = contrastRatio(relativeLuminance(resolvedLinear(severityEntry, tintBackdropEntry)), tintLum)
      const severityPass = severityOnTintRatio >= 4.5
      if (!severityPass) failCount++
      rows.push({
        themeId,
        fg: `severity-${severity}`,
        bg: `severity-${severity}-bg on ${backdropName}`,
        min: 4.5,
        ratio: severityOnTintRatio,
        pass: severityPass,
        fgHex: linearToHex(severityEntry.linear),
        bgHex: linearToHex(tintLinear),
      })
      checkedCount++
      const fgOnTintRatio = contrastRatio(relativeLuminance(resolvedLinear(foreground, tintBackdropEntry)), tintLum)
      const fgPass = fgOnTintRatio >= 4.5
      if (!fgPass) failCount++
      rows.push({
        themeId,
        fg: 'foreground',
        bg: `severity-${severity}-bg on ${backdropName}`,
        min: 4.5,
        ratio: fgOnTintRatio,
        pass: fgPass,
        fgHex: linearToHex(foreground.linear),
        bgHex: linearToHex(tintLinear),
      })
    }
  }
}

// ---- spec 012 (brand watermark): the mark's own worst-case composited backdrop ---------------
// The mark's rendered colour -- `--muted-foreground` masked at `--watermark-opacity` over
// `--background` (globals.css `.watermark-mark`'s own two declarations) -- composited as a
// backdrop, checked against the two text colours that can plausibly sit over it in the reading
// area: `--muted-foreground` itself (secondary/meta text) and `--chat-foreground` (primary
// prose). Both must clear 4.5:1 (WCAG AA body text), in every theme (research.md decision 13).

// Quality-gate remediation (code-reviewer, Medium): this whole block used to silently skip
// (via the outer `if`/an inner `continue`) whenever `--watermark-opacity` failed to parse or a
// theme was missing `muted-foreground`/`background`/the pair's own foreground token -- a
// future CSS edit that broke any of those would make this script report nothing but an
// all-PASS table instead of catching the regression. Every one of those cases now pushes a
// `pass: false` row (the PAIRS loop's own 'token missing' shape above) AND counts toward
// `checkedCount`/`failCount`, so a missing token fails the run (non-zero exit below) instead
// of quietly dropping out of the denominator.
if (watermarkOpacity === null) {
  checkedCount++
  failCount++
  rows.push({ themeId: '(root)', fg: '--watermark-opacity', bg: ':root', min: 4.5, ratio: null, pass: false, note: 'token missing' })
} else {
  for (const [themeId, props] of Object.entries(themes)) {
    const mutedFg = props['muted-foreground']
    const background = props['background']
    if (!mutedFg || !background) {
      checkedCount++
      failCount++
      rows.push({ themeId, fg: 'muted-foreground', bg: 'background', min: 4.5, ratio: null, pass: false, note: 'token missing' })
      continue
    }
    const markEntry = { raw: 'mark', alpha: watermarkOpacity, linear: mutedFg.linear }
    const markBackdropLinear = resolvedLinear(markEntry, background)
    const markBackdropEntry = { raw: 'mark-on-background', alpha: 1, linear: markBackdropLinear }
    for (const fg of ['muted-foreground', 'chat-foreground']) {
      const fgEntry = props[fg]
      if (!fgEntry) {
        checkedCount++
        failCount++
        rows.push({ themeId, fg, bg: 'mark-on-background', min: 4.5, ratio: null, pass: false, note: 'token missing' })
        continue
      }
      const fgLinear = resolvedLinear(fgEntry, markBackdropEntry)
      const ratio = contrastRatio(relativeLuminance(fgLinear), relativeLuminance(markBackdropLinear))
      const pass = ratio >= 4.5
      checkedCount++
      if (!pass) failCount++
      rows.push({
        themeId,
        fg,
        bg: 'mark-on-background',
        min: 4.5,
        ratio,
        pass,
        fgHex: linearToHex(fgLinear),
        bgHex: linearToHex(markBackdropLinear),
      })
    }
  }
}

// ---- issue #488 quality-gate remediation (HIGH, accessibility-auditor): the destructive Button
// variant's text used to sit on a translucent destructive-tinted fill, itself composited inside
// dialog footers (`bg-muted/50` over `bg-popover`, `AlertDialogFooter`/`DialogFooter`) -- at rest
// that measured well under the 4.5:1 WCAG AA floor, worse again on hover. Fixed in button.tsx by
// making the `destructive` variant an opaque fill (`bg-destructive text-destructive-foreground`,
// matching `default`'s own opaque pattern) with a `hover:bg-destructive/80` fade, the same
// convention as `default`'s `hover:bg-primary/80`. The accompanying Medium finding -- the
// destructive and shared focus rings measuring under the 3:1 WCAG 1.4.11 non-text floor against
// that same footer -- is fixed by dropping the shared ring's Tailwind alpha modifier (now
// rendered at `--ring`'s own full opacity) and raising the destructive variant's own focus ring
// to `/80`. This block verifies both fixes against the real composited footer backdrop every
// destructive dialog action (RemoveRepositoryDialog, DeleteDialog, SignOutDialog, RequestCard's
// Deny) renders on, not just the flat `--background` the PAIRS loop above already checks.
for (const [themeId, props] of Object.entries(themes)) {
  const muted = props['muted']
  const popover = props['popover']
  const destructive = props['destructive']
  const destructiveForeground = props['destructive-foreground']
  const ring = props['ring']
  if (!muted || !popover || !destructive || !destructiveForeground || !ring) {
    checkedCount++
    failCount++
    rows.push({ themeId, fg: 'destructive-foreground', bg: 'footer', min: 4.5, ratio: null, pass: false, note: 'token missing' })
    continue
  }
  const footerLinear = resolvedLinear({ raw: 'muted/50', alpha: 0.5, linear: muted.linear }, popover)
  const footerEntry = { raw: 'footer (muted/50 on popover)', alpha: 1, linear: footerLinear }

  const fills = [
    { label: 'destructive-fill-rest (footer)', entry: { raw: 'destructive (rest)', alpha: 1, linear: destructive.linear } },
    { label: 'destructive-fill-hover (footer)', entry: { raw: 'destructive/80 (hover)', alpha: 0.8, linear: destructive.linear } },
  ]
  for (const { label, entry } of fills) {
    const fillLinear = resolvedLinear(entry, footerEntry)
    const ratio = contrastRatio(relativeLuminance(destructiveForeground.linear), relativeLuminance(fillLinear))
    const pass = ratio >= 4.5
    checkedCount++
    if (!pass) failCount++
    rows.push({
      themeId,
      fg: 'destructive-foreground',
      bg: label,
      min: 4.5,
      ratio,
      pass,
      fgHex: linearToHex(destructiveForeground.linear),
      bgHex: linearToHex(fillLinear),
    })
  }

  const rings = [
    { label: 'ring (opaque, focus)', entry: { raw: 'ring (opaque)', alpha: 1, linear: ring.linear } },
    { label: 'destructive/80 (focus ring)', entry: { raw: 'destructive/80 (focus ring)', alpha: 0.8, linear: destructive.linear } },
  ]
  for (const { label, entry } of rings) {
    const ringLinear = resolvedLinear(entry, footerEntry)
    const ratio = contrastRatio(relativeLuminance(ringLinear), relativeLuminance(footerLinear))
    const pass = ratio >= 3
    checkedCount++
    if (!pass) failCount++
    rows.push({
      themeId,
      fg: label,
      bg: 'footer (muted/50 on popover)',
      min: 3,
      ratio,
      pass,
      fgHex: linearToHex(ringLinear),
      bgHex: linearToHex(footerLinear),
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
  const suffix = r.note ? `  (${r.fgHex} on ${r.bgHex}, ${r.note})` : `  (${r.fgHex} on ${r.bgHex})`
  console.log(row([r.themeId, pairLabel, r.ratio.toFixed(2) + ':1', r.min, result]) + suffix)
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
