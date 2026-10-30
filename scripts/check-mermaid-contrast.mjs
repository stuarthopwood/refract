#!/usr/bin/env node
// Verifies every built-in theme's Mermaid diagram colours with the real pinned mermaid package in a real Chromium (Electron) renderer.
// Mermaid derives several colours internally, which a static CSS-token check (check-theme-contrast.mjs) cannot see.
// Shape/pie checks read the computed style plus `elementsFromPoint`; text contrast is measured from visible-vs-hidden glyph screenshots
// (`measureTextFromScreenshots`) because hit-testing can't see a stroke under a label.
// Usage: node scripts/check-mermaid-contrast.mjs. Exits 1 if any check fails or a diagram resolves fewer checks than MIN_CHECKS_PER_DIAGRAM.

import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

// ---- diagram fixtures: one per diagram type MermaidBlock renders ----
// Timeline uses 12 sections and gitGraph 8 branches to reach every colour-scale / branch-label slot.

const DIAGRAMS = {
  flowchart: `flowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Do thing]\n  B -->|No| D[Other thing]\n`,
  sequence: `sequenceDiagram\n  participant Alice\n  participant Bob\n  Alice->>Bob: Hello\n  Note over Alice,Bob: a note\n  Bob-->>Alice: Hi\n`,
  er: `erDiagram\n  CUSTOMER {\n    string name\n    string id\n    string email\n  }\n  CUSTOMER ||--o{ ORDER : places\n`,
  // `excludes` targets two dates inside the Inside section only: `excludes weekends` always crosses a long Overflow label,
  // compositing the exclude band under the row stripe (a layout collision, not a theme defect).
  // `i1`-`i3` are clickable because they are the only tasks whose label sits inside its bar, which exercises `.taskText.clickable.active*Text*`.
  gantt: `gantt\n  title A Gantt Diagram\n  dateFormat YYYY-MM-DD\n  excludes 2024-02-10,2024-02-11\n  section Overflow\n  Done task with a very long label that overflows :done, o1, 2024-01-08, 1d\n  Active task with a very long label that overflows :active, o2, after o1, 1d\n  Critical task with a very long label that overflows :crit, o3, after o2, 1d\n  Active critical task with a very long label that overflows :active, crit, o3b, after o3, 1d\n  Future task with a very long label that overflows :o4, after o3b, 1d\n  section Inside\n  Done :done, i1, 2024-02-01, 20d\n  Active :active, i2, after i1, 20d\n  Crit :crit, i3, after i2, 20d\n  click i1 href "about:blank"\n  click i2 href "about:blank"\n  click i3 href "about:blank"\n`,
  pie: `pie title Twelve\n${Array.from({ length: 12 }, (_, i) => `  "S${i}" : ${i + 1}`).join('\n')}\n`,
  mindmap: `mindmap\n  root((Root))\n${Array.from({ length: 11 }, (_, i) => `    B${i}`).join('\n')}\n`,
  xychart: `xychart-beta\n  title "Sales"\n  x-axis [jan, feb, mar, apr]\n  y-axis "Revenue" 0 --> 100\n  bar [20, 40, 60, 80]\n  line [10, 30, 50, 70]\n`,
  timeline: `timeline\n  title Multi-section\n${Array.from({ length: 12 }, (_, i) => `  section S${i}\n    Y${2000 + i} : E${i}`).join('\n')}\n`,
  journey: `journey\n  title My day\n  section Morning\n    Wake up: 5: Me\n    Coffee: 3: Me\n  section Evening\n    Sleep: 4: Me\n`,
  gitGraph: `gitGraph\n  commit\n${Array.from({ length: 7 }, (_, i) => `  branch b${i}\n  checkout b${i}\n  commit`).join('\n')}\n  checkout main\n  merge b0\n`
}

// ---- per-diagram minimum resolved-check counts: fewer is a hard FAILURE, so a Mermaid markup change
// that stops selectors matching can't quietly shrink a diagram's checks to zero. ----

const MIN_CHECKS_PER_DIAGRAM = {
  flowchart: 2,
  sequence: 2,
  er: 1,
  gantt: 10,
  pie: 24, // 12 slices x (% label text, stroke vs fill) + 12 shape-vs-background
  mindmap: 11, // section--1 (root) through section-9 label text, at minimum
  xychart: 2,
  timeline: 12, // >=1 label/connector check per section, 12 sections
  journey: 4,
  gitGraph: 8 // >=1 branch-label check per branch, 8 branches
}

// ---- real `--card` surface colour per theme, parsed from globals.css (as check-theme-contrast.mjs does) ----
// Mermaid's `primaryColor` drifts from the real card surface for `dark` (#1f1f1f vs #171717), so diagrams are measured against the real token.
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
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  ]
}
function oklchToLinearSrgb(L, C, Hdeg) {
  const hRad = (Hdeg * Math.PI) / 180
  return oklabToLinearSrgb(L, C * Math.cos(hRad), C * Math.sin(hRad))
}
function srgbGammaEncode(c) {
  const clamped = Math.min(1, Math.max(0, c))
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055
}
function linearToHex([r, g, b]) {
  const toByte = (c) => Math.round(srgbGammaEncode(c) * 255)
  return '#' + [r, g, b].map((c) => toByte(c).toString(16).padStart(2, '0')).join('')
}

const globalsCssPath = path.join(repoRoot, 'src/renderer/styles/globals.css')
// The `.theme-<id>` regexes aren't comment-aware, so strip every CSS comment first (failing on an unterminated marker) to keep a commented-out token from parsing as live.
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
const globalsCss = stripCssComments(readFileSync(globalsCssPath, 'utf-8'), path.relative(repoRoot, globalsCssPath))
const OKLCH_RE = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)%)?\s*\)$/i
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i
// `--card` may be `var(--surface-1)` (#550), so resolve `var(--name)` hops before matching a literal (same as check-theme-contrast.mjs's `resolveRawValue`,
// duplicated because these one-off scripts don't import each other); an unresolvable `--card` is a hard failure, never a fallback.
const VAR_RE = /^var\(\s*--([a-z0-9-]+)\s*\)$/i
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
// `Object.create(null)`: a theme writing `var(--constructor)` would otherwise return a function from the lookup and `.match` would throw instead of the clear "cannot resolve --card" failure.
const realCardColors = Object.create(null)
for (const blockMatch of globalsCss.matchAll(/\.theme-([a-z0-9-]+)\s*\{([^}]*)\}/g)) {
  const themeId = blockMatch[1]
  const rawProps = Object.create(null)
  for (const propMatch of blockMatch[2].matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)) {
    rawProps[propMatch[1]] = propMatch[2].trim()
  }
  const resolved = resolveRawValue('card', rawProps)
  if (resolved === undefined) continue
  const oklchMatch = resolved.match(OKLCH_RE)
  const hexMatch = resolved.match(HEX_RE)
  if (oklchMatch) {
    const [, L, C, H] = oklchMatch
    realCardColors[themeId] = linearToHex(oklchToLinearSrgb(Number(L), Number(C), Number(H)))
  } else if (hexMatch) {
    realCardColors[themeId] = resolved
  }
}

// ---- stage a scratch dir: harness HTML + a generated Electron main script that renders every diagram/theme pair and dumps JSON ----

const workDir = mkdtempSync(path.join(tmpdir(), 'pinion-mermaid-contrast-'))
try {
  const mermaidEntry = pathToFileURL(
    path.join(repoRoot, 'node_modules/mermaid/dist/mermaid.esm.min.mjs')
  ).href

  cpSync(path.join(__dirname, 'mermaid-contrast-measure.mjs'), path.join(workDir, 'mermaid-contrast-measure.mjs'))

  writeFileSync(
    path.join(workDir, 'harness.html'),
    `<!DOCTYPE html><html><body><script type="module">
import mermaid from '${mermaidEntry}'
import { prepare, hideGlyphs, cleanup } from './mermaid-contrast-measure.mjs'
window.__mermaid = mermaid
window.__prepare = prepare
window.__hideGlyphs = hideGlyphs
window.__cleanup = cleanup
window.__ready = true
</script></body></html>`
  )

  // Import the app's own mermaidTheme.ts (the module MermaidBlock uses) via Node's TS support, copied to `.mts` so it loads as ESM despite `"type": "commonjs"`.
  // It imports `./mermaidThemeData` and Node needs an explicit extension for relative specifiers, so copy that too
  // (no runtime imports of its own) and rewrite the specifier to the copy's `.mts` name.
  const tsSourcePath = path.join(repoRoot, 'src/shared/mermaidTheme.ts')
  const mtsPath = path.join(workDir, 'mermaidTheme.mts')
  const mermaidThemeDataSourcePath = path.join(repoRoot, 'src/shared/mermaidThemeData.ts')
  const mermaidThemeDataMtsPath = path.join(workDir, 'mermaidThemeData.mts')
  cpSync(mermaidThemeDataSourcePath, mermaidThemeDataMtsPath)
  const mermaidThemeSource = readFileSync(tsSourcePath, 'utf-8').replace(
    /(['"])\.\/mermaidThemeData\1/g,
    "$1./mermaidThemeData.mts$1"
  )
  writeFileSync(mtsPath, mermaidThemeSource)
  const { MERMAID_THEME_VARIABLES, getMermaidThemeCSS } = await import(pathToFileURL(mtsPath).href)

  const themeCSSByTheme = Object.fromEntries(
    Object.keys(MERMAID_THEME_VARIABLES).map((themeId) => [themeId, getMermaidThemeCSS(themeId)])
  )

  // Hard failure, no `primaryColor` fallback: every declared theme must resolve a real `--card`, or shape and pie checks use the wrong backdrop.
  const unresolvedCardThemes = Object.keys(MERMAID_THEME_VARIABLES).filter((themeId) => !realCardColors[themeId])
  if (unresolvedCardThemes.length > 0) {
    throw new Error(
      `check-mermaid-contrast: --card could not be resolved to a real colour for: ${unresolvedCardThemes.join(', ')} ` +
      `(globals.css's .theme-<id> block is missing --card, or it is a var() chain this script's resolver can't follow). ` +
      `Refusing to fall back to Mermaid's own primaryColor stand-in.`
    )
  }

  // `force-device-scale-factor=1` maps CSS pixels 1:1 onto the `capturePage()` bitmap regardless of OS display scaling, which the per-pixel diffing needs.
  const mainScript = `
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.disableHardwareAcceleration()
const THEMES = ${JSON.stringify(MERMAID_THEME_VARIABLES)}
const THEME_CSS = ${JSON.stringify(themeCSSByTheme)}
const REAL_CARD_COLORS = ${JSON.stringify(realCardColors)}
const DIAGRAMS = ${JSON.stringify(DIAGRAMS)}

// Pure sRGB/WCAG contrast math, duplicated by hand from scripts/mermaid-contrast-measure.mjs's own
// copy: that file is ESM and runs only inside the renderer; this generated script is CommonJS and
// runs only in the Electron MAIN process (the one place \`webContents.capturePage\` is callable) --
// there is no module system both can import from without adding a build step for a 10-line helper.
function srgbToLinear(c) {
  c /= 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
function relativeLuminance(c) {
  return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b)
}
function contrastRatio(a, b) {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

// Quality-gate remediation (round 6): diffs the "glyphs visible" and "glyphs hidden" screenshots
// within each text leaf's own bounding rect to find its real rendered ink pixels, then reads BOTH
// the real foreground (visible capture) and the real background (hidden capture) directly off
// those pixels -- never a value read off a CSS rule or modelled by walking \`elementsFromPoint\`, so
// it needs no special case for a painted stroke, a gradient, a filter, or any other paint source:
// it just asks the actual rendered pixels what is there. Mirrors the technique both independent
// round-5 re-gate reviewers used in their own from-scratch harnesses to catch what this script's
// prior \`elementsFromPoint\`-based text measurement missed (a gitGraph commit-label's semi-opaque
// background rect sitting on top of a bright branch-line STROKE). \`toBitmap()\` returns raw BGRA
// pixel data (verified against a real capture, see this script's own comment above \`mainScript\`).
//
// A single "pick the single highest-diff pixel in the rect" pass (this function's own first
// implementation) is NOT enough: verified against a real gitGraph render where a rotated
// commit-label's glyphs cross BOTH the plain dark page background and a bright branch-line blend
// within the same bounding rect, picking one global max-diff pixel always landed on the (higher-
// raw-delta, easier) plain-background portion of the glyph and reported a comfortable PASS even
// though the SAME glyph, where it crosses the bright blend, measured a real 1.4-2.0:1 -- exactly
// the kind of failure this round's methodology exists to catch. Instead: bucket every
// sufficiently-inked pixel in the rect by its OWN "hidden" (background) colour (several buckets
// exist whenever a glyph's rect spans more than one real background), keep each bucket's highest-
// diff pixel as that background's representative (the most fully-inked sample against THAT
// specific background), and report the WORST (minimum) ratio across every bucket with at least
// \`MIN_BUCKET_PIXELS\` qualifying pixels -- so a glyph is only reported as passing if every
// MEANINGFULLY-SIZED distinct background it actually crosses clears the minimum (see
// \`MIN_BUCKET_PIXELS\`'s own comment for why a pixel-count floor is necessary too: a handful of
// anti-aliasing-boundary pixels, e.g. where a label's own background box corner blends with
// whatever sits immediately behind it, produced near-1:1 ratios that flickered between PASS and
// FAIL across repeated runs of the SAME static fixture -- real but imperceptibly narrow noise,
// not a rendered difference any user could ever see).
function measureTextFromScreenshots(textItems, visibleImage, hiddenImage) {
  const size = visibleImage.getSize()
  const visible = visibleImage.toBitmap()
  const hidden = hiddenImage.toBitmap()
  const width = size.width
  function pixelAt(buf, x, y) {
    const idx = (y * width + x) * 4
    return { b: buf[idx], g: buf[idx + 1], r: buf[idx + 2], a: 1 }
  }
  // Below this, a pixel's visible/hidden difference is anti-aliasing fringe (partial glyph
  // coverage blended with its own background) rather than real ink -- verified against a real
  // capture, where genuine fringe pixels measured diff 13-45 (near-1:1 apparent ratio, since fg
  // and bg are still almost identical at that coverage) while real, fully-inked glyph pixels
  // measured diff >=60 against every background they were checked against.
  const MIN_INK_DIFF = 60
  // Background colours are bucketed (rounded to the nearest 12 per channel) rather than compared
  // exactly, since a glyph crossing a gradient or an anti-aliased shape edge sees many slightly
  // different background values that are really the same visual region.
  const BUCKET_SIZE = 12
  // A bucket below this many pixels is a narrow anti-aliasing-boundary artefact (e.g. a label's
  // own background box's rounded corner blending with whatever sits immediately behind it for a
  // pixel or two), not a REAL second background the glyph is meaningfully readable against --
  // verified against two real captures at native scale (see this function's own header comment on
  // why native scale matters): the real gitGraph commit-label regression this methodology exists
  // to catch produces a 192-220-pixel bad bucket (a real fraction of the glyph, consistently
  // reproducible), while unrelated labels merely brushing past a line/shape edge produced only
  // 1-30-pixel buckets that flipped between PASS and FAIL across repeated runs of the SAME static
  // fixture -- sub-pixel text-layout/hinting noise, not a real rendered difference a user would
  // ever perceive. 40 sits well above the noise band and well below the real regression's.
  const MIN_BUCKET_PIXELS = 40
  const checks = []
  for (const item of textItems) {
    const buckets = new Map()
    for (let y = item.rect.top; y < item.rect.bottom; y++) {
      for (let x = item.rect.left; x < item.rect.right; x++) {
        const v = pixelAt(visible, x, y)
        const h = pixelAt(hidden, x, y)
        const diff = Math.abs(v.r - h.r) + Math.abs(v.g - h.g) + Math.abs(v.b - h.b)
        if (diff < MIN_INK_DIFF) continue
        const key = Math.round(h.r / BUCKET_SIZE) + ',' + Math.round(h.g / BUCKET_SIZE) + ',' + Math.round(h.b / BUCKET_SIZE)
        const existing = buckets.get(key)
        if (existing) {
          existing.count++
          if (diff > existing.diff) {
            existing.diff = diff
            existing.fg = v
            existing.bg = h
          }
        } else {
          buckets.set(key, { count: 1, diff, fg: v, bg: h })
        }
      }
    }
    const significant = Array.from(buckets.values()).filter((b) => b.count >= MIN_BUCKET_PIXELS)
    // No background crossed by this glyph had a large-enough inked region at all (e.g. a zero-size
    // or fully-transparent leaf) -- a hard FAIL rather than a silently-skipped check.
    if (significant.length === 0) {
      checks.push({ label: item.label, ratio: null, min: item.min, pass: false, note: 'no distinguishable glyph pixel found in the rendered screenshot' })
      continue
    }
    let worst = null
    for (const rep of significant) {
      const ratio = contrastRatio(rep.fg, rep.bg)
      if (!worst || ratio < worst) worst = ratio
    }
    checks.push({ label: item.label, ratio: worst, min: item.min, pass: worst >= item.min })
  }
  return checks
}

async function main() {
  // Generous viewport: Gantt/timeline/gitGraph fixtures render far wider/taller than Electron's
  // 800x600 default, and any element positioned outside the viewport is unreachable by
  // \`elementsFromPoint\`/\`getBoundingClientRect\`-based sampling below -- silently dropping real
  // checks rather than failing them, the exact round-4 failure mode this round replaced.
  // \`backgroundThrottling: false\` (round 6): a hidden window's renderer is otherwise throttled as
  // if backgrounded, which can leave \`capturePage()\` returning a stale/blank frame -- see
  // mermaid-contrast-measure.mjs's own \`waitForPaint\` comment for the real-capture verification.
  const win = new BrowserWindow({ show: false, width: 3000, height: 4000, webPreferences: { contextIsolation: false, backgroundThrottling: false } })
  await win.loadFile(${JSON.stringify(path.join(workDir, 'harness.html'))})
  await win.webContents.executeJavaScript('new Promise(r => { const i = setInterval(() => { if (window.__ready) { clearInterval(i); r(true) } }, 20) })')
  const results = {}
  for (const [themeId, themeVariables] of Object.entries(THEMES)) {
    results[themeId] = {}
    // No \`|| themeVariables.primaryColor\` fallback: the hard check above guarantees every
    // theme here already has a real, resolved \`--card\`.
    const cardColor = REAL_CARD_COLORS[themeId]
    const themeCSS = THEME_CSS[themeId]
    for (const [diagramType, code] of Object.entries(DIAGRAMS)) {
      const args = { themeVariables, themeCSS, code, cardColor, diagramType }
      const prepared = await win.webContents.executeJavaScript('window.__prepare(' + JSON.stringify(args) + ')')
      if (!prepared.ok) {
        results[themeId][diagramType] = prepared
        continue
      }
      const visibleImage = await win.webContents.capturePage()
      await win.webContents.executeJavaScript('window.__hideGlyphs()')
      const hiddenImage = await win.webContents.capturePage()
      await win.webContents.executeJavaScript('window.__cleanup()')
      const textChecks = measureTextFromScreenshots(prepared.textItems, visibleImage, hiddenImage)
      results[themeId][diagramType] = { ok: true, checks: [...prepared.shapeChecks, ...textChecks] }
    }
  }
  fs.writeFileSync(${JSON.stringify(path.join(workDir, 'results.json'))}, JSON.stringify(results))
  app.quit()
}
app.whenReady().then(main)
`
  const mainPath = path.join(workDir, 'main.js')
  writeFileSync(mainPath, mainScript)

  // `require('electron')` resolves to the real electron.exe path without a shell (unlike the .cmd shim).
  const electronBin = (await import('electron')).default
  await execFileAsync(electronBin, [mainPath, '--no-sandbox'], { cwd: repoRoot, timeout: 90_000 })

  const results = JSON.parse(readFileSync(path.join(workDir, 'results.json'), 'utf-8'))

  // ---- assemble the check table + MIN_CHECKS_PER_DIAGRAM gate ----

  const rows = []
  let failCount = 0

  for (const [themeId, diagrams] of Object.entries(results)) {
    for (const [diagramType, result] of Object.entries(diagrams)) {
      if (!result.ok) {
        rows.push({ themeId, diagramType, label: 'render', ratio: null, min: null, pass: false, note: result.error })
        failCount++
        continue
      }
      for (const check of result.checks) {
        rows.push({ themeId, diagramType, label: check.label, ratio: check.ratio, min: check.min, pass: check.pass, note: check.note })
        if (!check.pass) failCount++
      }
      const expected = MIN_CHECKS_PER_DIAGRAM[diagramType] ?? 1
      const actual = result.checks.length
      if (actual < expected) {
        rows.push({
          themeId,
          diagramType,
          label: 'insufficient checks resolved',
          ratio: null,
          min: null,
          pass: false,
          note: `expected >=${expected}, resolved ${actual} -- a selector likely stopped matching Mermaid's rendered markup`
        })
        failCount++
      }
    }
  }

  // ---- print the table ----

  const header = ['theme', 'diagram', 'check', 'ratio', 'min', 'result']
  const widths = [18, 10, 50, 8, 5, 6]
  const row = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join(' ')
  console.log(row(header))
  console.log(row(widths.map((w) => '-'.repeat(w))))
  for (const r of rows) {
    if (r.ratio === null) {
      console.log(row([r.themeId, r.diagramType, r.label, 'n/a', '-', 'FAIL']) + `  (${r.note})`)
      continue
    }
    console.log(row([r.themeId, r.diagramType, r.label, r.ratio.toFixed(2) + ':1', r.min, r.pass ? 'PASS' : 'FAIL']))
  }

  console.log('')
  if (rows.length === 0) {
    console.log('no mermaid colour checks resolved -- diagram rendering may have changed shape')
    process.exitCode = 2
  } else if (failCount > 0) {
    console.log(`${failCount} of ${rows.length} mermaid colour check(s) FAILED their contrast minimum`)
    process.exitCode = 1
  } else {
    console.log(`all ${rows.length} mermaid colour checks across ${Object.keys(results).length} theme(s) PASS`)
    process.exitCode = 0
  }
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
