#!/usr/bin/env node
// Verifies every built-in theme's WCAG contrast ratios from the real CSS tokens; exits 1 on any failing pair.
// Out-of-gamut oklch() colours are clipped like an sRGB display would, so wide-gamut (P3) luminance can differ slightly.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PAIRS, MARKDOWN_PAIRS, mermaidAccentRows, searchFieldContrastRows, userBubbleContrastRows, sidebarBorderContrastRows, shikiTokenContrastRows } from './theme-contrast-pairs.mjs'
import { swatchMetadataDriftCheck } from './theme-swatch-drift.mjs'
import { switchTrackContrastRows } from './switch-track-contrast.mjs'
import { composerSelectionContrastRows, COMMAND_PILL_PAIRS } from './composer-selection-contrast.mjs'
import { focusedBadgeContrastRows } from './focused-badge-contrast.mjs'
import { contextUsageContrastRows } from './context-usage-contrast.mjs'; import { findNavContrastRows } from './find-nav-contrast.mjs'; import { recommendedHoverContrastRows } from './recommended-hover-contrast.mjs'
import { contrastRatio, linearToHex, relativeLuminance, resolvedLinear } from './contrast-math.mjs'
import { css, cssPath, repoRoot, themes, sidebarBorderAliasesDivider } from './theme-tokens.mjs'

// A ThemeId declared in themes.ts with no `.theme-<id>` block would silently drop out of the table and still
// exit 0, so parse the union and fail loudly for any missing block. The union may wrap lines (no trailing `;`);
// matching nothing is itself a hard failure (exit 2).
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

// The tempered `(?:(?!id:)[\s\S])*?` gaps stop each match at the next `id:`, so an entry missing a field cannot
// read the NEXT entry's values; the count check below turns that into a hard failure. `symbolColor` must be an
// opaque hex (Electron's setTitleBarOverlay has no alpha), hand-computed rather than a `var()`.
const THEME_METADATA_RE = /id:\s*'([a-z0-9-]+)'(?:(?!id:)[\s\S])*?swatch:\s*'(#[0-9a-fA-F]{3,8})'(?:(?!id:)[\s\S])*?swatchPrimary:\s*'(#[0-9a-fA-F]{3,8})'(?:(?!id:)[\s\S])*?syntaxTheme:\s*'([a-z0-9-]+)'(?:(?!id:)[\s\S])*?titleBarOverlay:\s*\{\s*color:\s*'(#[0-9a-fA-F]{3,8})'\s*,\s*symbolColor:\s*'(#[0-9a-fA-F]{3,8})'/g
const themeMetadata = Object.create(null)
for (const m of themesTs.matchAll(THEME_METADATA_RE)) {
  themeMetadata[m[1]] = {
    swatch: m[2].toLowerCase(),
    swatchPrimary: m[3].toLowerCase(),
    syntaxTheme: m[4],
    titleBarOverlayColor: m[5].toLowerCase(),
    symbolColor: m[6].toLowerCase(),
  }
}
if (Object.keys(themeMetadata).length !== declaredThemeIds.length) {
  console.error(
    `parsed ${Object.keys(themeMetadata).length} theme metadata entries out of ${declaredThemeIds.length} declared ThemeId(s) in ${path.relative(repoRoot, themesTsPath)} -- THEME_METADATA_RE failed to match at least one entry`,
  )
  process.exit(2)
}

// `--watermark-opacity` has one `:root` default; a theme scope may override it where its background needs it.
const ROOT_BLOCK_RE = /:root\s*\{([^}]*)\}/
const WATERMARK_OPACITY_RE = /--watermark-opacity:\s*([\d.]+)\s*;/
const rootMatch = css.match(ROOT_BLOCK_RE)
const watermarkOpacityMatch = rootMatch ? rootMatch[1].match(WATERMARK_OPACITY_RE) : null
const watermarkOpacity = watermarkOpacityMatch ? Number(watermarkOpacityMatch[1]) : null
const themeWatermarkOpacity = (themeId) => {
  const block = css.match(new RegExp(`\\.theme-${themeId}\\s*\\{([^}]*)\\}`))
  const override = block ? block[1].match(WATERMARK_OPACITY_RE) : null
  return override ? Number(override[1]) : watermarkOpacity
}

// Soft decorative dividers (`--divider`, never `--border`) carry no WCAG 1.4.11 floor, so presence only --
// except where a preset's `--sidebar-border` aliases `--divider` (a real hover fill), which a check below floors.
// Dark (high contrast)'s stricter divider treatment is deferred to #552.
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

// Moved to theme-contrast-pairs.mjs for the #806 file-size cap; confirms themes.ts swatch literals match the resolved CSS tokens.
const swatchDrift = swatchMetadataDriftCheck(themes, themeMetadata, declaredThemeIds)
checkedCount += swatchDrift.checkedCount
failCount += swatchDrift.failCount
rows.push(...swatchDrift.rows); { const d = mermaidAccentRows(themes); checkedCount += d.checkedCount; failCount += d.failCount; rows.push(...d.rows) }

// The Agents/Todo cards' `PopoverContent` is a separate surface for these tokens; kept here, not in
// theme-contrast-pairs.mjs, for the #806 file-size cap.
const READOUT_CARD_PAIRS = [
  // Icon-only (`aria-hidden`) glyphs.
  { fg: 'state-working', bg: 'popover', min: 3 },
  // "Blocked: <blocker>" is real body text, not just the icon covered by the 3:1 pair in `PAIRS`.
  { fg: 'severity-warning', bg: 'popover', min: 4.5 },
  // Completed-task icon and text are `text-severity-success` (the gated 4.5:1 "done is green" exception), so body text needs this surface too.
  { fg: 'severity-success', bg: 'popover', min: 4.5 }
]
// `COMMAND_PILL_PAIRS` lives in composer-selection-contrast.mjs; merged into the same per-theme loop.
for (const [themeId, props] of Object.entries(themes)) {
  for (const { fg, bg, on, min, onlyThemes, informationalThemes } of [...PAIRS, ...COMMAND_PILL_PAIRS, ...READOUT_CARD_PAIRS, ...MARKDOWN_PAIRS]) {
    // `informationalThemes` pairs are computed and printed but never counted toward pass/fail (a ratio accepted below the floor on purpose).
    const scopedThemes = informationalThemes ?? onlyThemes
    if (scopedThemes && !scopedThemes.includes(themeId)) continue
    const informational = Boolean(informationalThemes)
    const fgEntry = props[fg]
    const bgEntry = props[bg]
    if (!fgEntry || !bgEntry) {
      if (informational) continue
      checkedCount++
      failCount++
      rows.push({ themeId, fg, bg, min, ratio: null, pass: false, note: 'token missing' })
      continue
    }
    // `on` names the opaque surface a translucent `bg` actually paints over.
    const onEntry = on ? props[on] : bgEntry
    if (!onEntry) {
      checkedCount++
      failCount++
      rows.push({ themeId, fg, bg: `${bg} on ${on}`, min, ratio: null, pass: false, note: 'token missing' })
      continue
    }
    const bgLinear = resolvedLinear(bgEntry, onEntry)
    const fgLinear = resolvedLinear(fgEntry, on ? { raw: 'composite', alpha: 1, linear: bgLinear } : bgEntry)
    const ratio = contrastRatio(relativeLuminance(fgLinear), relativeLuminance(bgLinear))
    const pass = ratio >= min
    if (informational) {
      rows.push({
        themeId,
        fg,
        bg,
        min,
        ratio,
        pass,
        fgHex: linearToHex(fgLinear),
        bgHex: linearToHex(bgLinear),
        informational: true,
        note: 'informational, #927 accepted departure -- not enforced',
      })
      continue
    }
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

// Decorative-divider pairs: no floor in any theme, but still fail if the token is missing.
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

// A `--sidebar-border` written as literal `var(--divider)` (captured from the unresolved text; Obsidian only) is a
// real hover fill (`hover:bg-sidebar-border`), so it gets a 4.5:1 floor against `--muted-foreground`.
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

// Surface ladder: luminance must not decrease from background through surface 1-3; equal steps are allowed
// (Dark/HC set --surface-1 equal to --surface-2 on purpose).
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
      const pass = /^light/.test(themeId) ? lum <= prevLum + 1e-9 : lum >= prevLum - 1e-9
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
        note: pass ? undefined : `'--${name}' is darker than '--${prevName}' -- the surface ladder must keep its direction (lighter for dark presets, darker for light)`,
      })
    }
    prevName = name
    prevLum = lum
  }
}

// Severity `-bg` tints are translucent, so check coloured text and plain `--foreground` on the tint composited over
// background, card and popover (dialogs/sheets/menus render on `bg-popover`). Deliberately not `--muted`:
// Obsidian's severity colours cannot clear 4.5:1 on both a `--muted` tint and `--popover`; add it here if a banner ever sits there.
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

// Watermark mark composited over the background must clear 4.5:1 against `--muted-foreground` and `--chat-foreground`.
// A missing token pushes a failing row (and counts toward failCount) so a CSS edit cannot silently skip the check.
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
    // `--muted-foreground` is itself translucent, and CSS `opacity` multiplies with it, so the mark's alpha is the product.
    const markEntry = { raw: 'mark', alpha: mutedFg.alpha * themeWatermarkOpacity(themeId), linear: mutedFg.linear }
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

// Destructive button variant (opaque fill) and the focus rings, checked against the real composited dialog footer
// (`bg-surface-subtle`, muted at 50%, over `bg-popover`), not just the flat `--background` the PAIRS loop uses (#488).
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

// These composited checks live in theme-contrast-pairs.mjs to keep this file at its #806 size baseline; merged into one loop.
// The OKLCH blend, composer-selection, focused-badge and context-usage rows each live in their own module, merged here too.
for (const row of [...searchFieldContrastRows(themes), ...userBubbleContrastRows(themes), ...sidebarBorderContrastRows(themes), ...switchTrackContrastRows(themes), ...composerSelectionContrastRows(themes), ...focusedBadgeContrastRows(themes), ...contextUsageContrastRows(themes), ...findNavContrastRows(themes), ...recommendedHoverContrastRows(themes), ...(await shikiTokenContrastRows(themes, themeMetadata))]) {
  checkedCount++
  if (!row.pass) failCount++
  rows.push(row)
}

// ---- print the table ---------------------------------------------------------------------

// Reads the PAIRS tuple array out of themeContrast.ts: bracket-match the literal, then parse it as JSON (strings and numbers only).
function readInAppPairs(src) {
  const start = src.indexOf('[', src.indexOf('=', src.indexOf('const PAIRS')))
  let depth = 0
  let quote = null
  let end = -1
  for (let i = start; i < src.length && end < 0; i++) {
    const c = src[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === "'" || c === '"') quote = c
    else if (c === '/' && src[i + 1] === '/') i = src.indexOf('\n', i)
    else if (c === '[') depth++
    else if (c === ']' && --depth === 0) end = i
  }
  const literal = src
    .slice(start, end + 1)
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/'/g, '"')
    .replace(/,(\s*\])/g, '$1')
  return JSON.parse(literal)
}
// The in-app custom-theme warnings must be a subset of this gate's pairs (same fg/bg, same or looser floor), or they drift apart.
const inAppSrc = readFileSync(path.join(repoRoot, 'src/renderer/lib/themeContrast.ts'), 'utf-8')
const gateKeys = new Map()
for (const p of [...PAIRS, ...COMMAND_PILL_PAIRS, ...READOUT_CARD_PAIRS, ...MARKDOWN_PAIRS]) {
  // The in-app warnings run on every theme, so a pair scoped to some themes does not cover them.
  if (p.onlyThemes || p.informationalThemes) continue
  const key = `${p.fg}|${p.bg}`
  gateKeys.set(key, Math.min(p.min, gateKeys.get(key) ?? Infinity))
}
// Gated by userBubbleContrastRows rather than a plain pair.
gateKeys.set('chat-user-bubble-fg|chat-user-bubble-bg', 4.5)
for (const [fg, bg, min] of readInAppPairs(inAppSrc)) {
  checkedCount++
  const gateMin = gateKeys.get(`${fg}|${bg}`)
  if (gateMin === undefined || gateMin < min) {
    failCount++
    rows.push({ themeId: 'in-app', fg, bg, min, ratio: null, pass: false, note: 'in-app pair missing from the gate or its floor is lower there' })
  }
}
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
  const result = r.informational ? 'INFO' : r.pass ? 'PASS' : 'FAIL'
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
