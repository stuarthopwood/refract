#!/usr/bin/env node
// Verifies every built-in theme's Mermaid diagram colours for real, measured contrast, rendered
// with the REAL pinned mermaid@11.17.2 package inside a real Chromium renderer (Electron -- the
// same engine the app itself uses for `MermaidBlock`), not a mock. Companion to
// check-theme-contrast.mjs (which checks the app's own CSS tokens only): this script exists
// because Mermaid computes several diagram colours (pie slices, mindmap/timeline section fills,
// Gantt text-on-bar/overflow, journey/gitGraph fills) from theme variables via its own internal
// derivation logic, which a static CSS-token check cannot see -- only a real render can.
//
// Quality-gate remediation (round 5): this round REPLACES the entire measurement methodology.
// Round 4's version (182/182 PASS) extracted `fill:`/`stroke:` values by regex-matching Mermaid's
// generated `<style>` block TEXT, one diagram-specific pattern per check -- it could only read a
// CSS rule's DECLARED value, never ask which rule actually WINS the cascade for a given element
// (specificity/`!important`/source order) or what shape is actually underneath a piece of text.
// Two independent reviewers (code-reviewer, accessibility-auditor) each built their OWN
// from-scratch harness against the real rendered DOM instead and converged on the same 3 real
// failures that regex-over-CSS-text methodology could not see (see src/shared/mermaidTheme.ts's
// own round-5 header comment for the full list and fixes). This script now does what they did:
// renders every fixture for real, inserts the resulting SVG into a live page, and for every
// actually-rendered text/shape element reads its colour via `getComputedStyle` (the browser's own
// cascade resolution) and finds whatever real shape is painted underneath via
// `document.elementsFromPoint`, alpha-compositing every layer found (see
// scripts/mermaid-contrast-measure.mjs's own header comment for the full algorithm, including its
// one documented limitation: only the `brightness()` CSS filter function is modelled).
//
// Fixtures were also widened past what round 4's methodology was ever exercised against: Timeline
// from 4 sections to 12 (Mermaid's own `THEME_COLOR_LIMIT`, reaching `cScale11`/section-10, which
// 4 sections structurally cannot); gitGraph from 2 branches to 8 (reaching every `git0`-`git7`/
// `gitBranchLabel0`-`gitBranchLabel7` slot, not just the first two); Gantt's Overflow section
// gained an active+crit combined row (`.activeCritText*.taskTextOutside*`, the exact combination
// round 4's own fixture never exercised).
//
// Quality-gate remediation (round 6): the round-5 methodology described above (computed style +
// `elementsFromPoint`) is now used ONLY for shape-vs-background and pie-slice checks. TEXT
// contrast is measured a different way: render the diagram's glyphs visible, screenshot, hide
// every glyph (`opacity: 0`), screenshot again, and diff the two real captures to find each
// glyph's actual painted pixels (`measureTextFromScreenshots` below) -- see that function's own
// comment for why (round 5's own replacement still missed a real regression: a gitGraph
// commit-label's semi-opaque background sitting on a bright branch-line STROKE, which
// `elementsFromPoint`-based compositing cannot see since it only ever reads a hit-tested
// element's `fill`/`background-color`, never a stroke). `cardColor` (the wrapper's own backdrop,
// and every pie-slice-vs-card check) now also resolves the app's REAL `--card` CSS token from
// globals.css instead of reusing Mermaid's own unrelated `primaryColor` theme variable, which
// had quietly drifted off the real value for the `dark` theme (`#1f1f1f` vs the real `#171717`).
//
// Usage: node scripts/check-mermaid-contrast.mjs
// Exits 1 if any check fails its minimum (or a diagram type resolved fewer checks than its own
// declared minimum -- see MIN_CHECKS_PER_DIAGRAM), 0 if every check across every theme/diagram
// passes.

import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

// ---- diagram fixtures: one per diagram type MermaidBlock actually renders ---------------------
// (round 5: timeline widened 4 -> 12 sections to reach `cScale11`/section-10; gitGraph widened
// 2 -> 8 branches to reach every `git<N>`/`gitBranchLabel<N>` slot; Gantt's Overflow section
// gained an active+crit combined overflowing row.)

const DIAGRAMS = {
  flowchart: `flowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Do thing]\n  B -->|No| D[Other thing]\n`,
  sequence: `sequenceDiagram\n  participant Alice\n  participant Bob\n  Alice->>Bob: Hello\n  Note over Alice,Bob: a note\n  Bob-->>Alice: Hi\n`,
  er: `erDiagram\n  CUSTOMER {\n    string name\n    string id\n    string email\n  }\n  CUSTOMER ||--o{ ORDER : places\n`,
  // Round 5: `excludes` moved off `weekends` onto two specific dates (2024-02-10/11) that fall
  // only within the Inside section's long, non-overflowing bars, not anywhere near the Overflow
  // section's deliberately long overflow labels -- `excludes weekends` recurs every 7 days, which
  // a ~230px-wide overflow label (spanning multiple day-columns) is geometrically guaranteed to
  // cross for at least one of the five Overflow tasks regardless of start date, compositing the
  // exclude-range band's own fill UNDER the alternating section-row stripe at that exact pixel --
  // a real, measured, but purely coincidental LAYOUT collision between two unrelated decorative
  // bands, not a theme-colour defect (Mermaid attaches no CSS class either one could target based
  // on what it happens to visually overlap). The dedicated `.exclude-range vs background` check
  // below still exercises the same real rendered band/colour either way. Round 6: `i1`-`i3` (the
  // Inside section's short-label-on-long-bar tasks) are also made clickable, via `click <id> href
  // "<url>"` -- these are the ONLY tasks whose rendered label sits fully INSIDE its own done/
  // active/crit bar (the Overflow section's labels are deliberately long enough to always spill
  // OUTSIDE their bar instead, a different Mermaid CSS codepath -- see this file's own header
  // comment), so this is what actually exercises `.taskText.clickable.activeText*`/
  // `.taskText.clickable.activeCritText*` (round 6's High fix) rather than just `.doneText*`
  // (round 5's fix, the only one the Overflow section's own clickable-free fixture ever reached).
  gantt: `gantt\n  title A Gantt Diagram\n  dateFormat YYYY-MM-DD\n  excludes 2024-02-10,2024-02-11\n  section Overflow\n  Done task with a very long label that overflows :done, o1, 2024-01-08, 1d\n  Active task with a very long label that overflows :active, o2, after o1, 1d\n  Critical task with a very long label that overflows :crit, o3, after o2, 1d\n  Active critical task with a very long label that overflows :active, crit, o3b, after o3, 1d\n  Future task with a very long label that overflows :o4, after o3b, 1d\n  section Inside\n  Done :done, i1, 2024-02-01, 20d\n  Active :active, i2, after i1, 20d\n  Crit :crit, i3, after i2, 20d\n  click i1 href "about:blank"\n  click i2 href "about:blank"\n  click i3 href "about:blank"\n`,
  pie: `pie title Twelve\n${Array.from({ length: 12 }, (_, i) => `  "S${i}" : ${i + 1}`).join('\n')}\n`,
  mindmap: `mindmap\n  root((Root))\n${Array.from({ length: 11 }, (_, i) => `    B${i}`).join('\n')}\n`,
  xychart: `xychart-beta\n  title "Sales"\n  x-axis [jan, feb, mar, apr]\n  y-axis "Revenue" 0 --> 100\n  bar [20, 40, 60, 80]\n  line [10, 30, 50, 70]\n`,
  timeline: `timeline\n  title Multi-section\n${Array.from({ length: 12 }, (_, i) => `  section S${i}\n    Y${2000 + i} : E${i}`).join('\n')}\n`,
  journey: `journey\n  title My day\n  section Morning\n    Wake up: 5: Me\n    Coffee: 3: Me\n  section Evening\n    Sleep: 4: Me\n`,
  gitGraph: `gitGraph\n  commit\n${Array.from({ length: 7 }, (_, i) => `  branch b${i}\n  checkout b${i}\n  commit`).join('\n')}\n  checkout main\n  merge b0\n`
}

// ---- per-diagram-type minimum resolved-check counts: an actual count BELOW this is a hard
// FAILURE ("insufficient checks resolved"), never a silent skip -- a Mermaid markup-shape change
// that stops every text leaf/shape selector from matching fails loudly instead of the check table
// quietly shrinking to zero for that diagram type. Each fixture above is sized to clear its own
// minimum. -------------------------------------------------------------------------------------

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

// ---- real `--card` surface colour per theme, parsed straight from the same CSS tokens
// check-theme-contrast.mjs verifies (globals.css), NOT Mermaid's own `primaryColor` theme
// variable -----------------------------------------------------------------------------------
// Quality-gate remediation (Medium, code-reviewer): this script previously used
// `themeVariables.primaryColor` (Mermaid's OWN internal diagram-background variable, tuned for
// its own node/pie/mindmap fills) as a stand-in for "the real card surface a diagram sits on in
// the app", for the wrapper's own background AND every pie-slice-vs-card check below. For
// `dark-high-contrast` the two happen to already agree, but for `dark` they do not:
// `primaryColor` is `#1f1f1f` while the app's own `--card: oklch(0.205 0 0)` is actually
// `#171717` (verified by converting through the same OKLab<->linear-sRGB matrices
// check-theme-contrast.mjs uses) -- a visibly different, if close, shade. Parsing the real token
// here (same regex/conversion approach as check-theme-contrast.mjs) measures every diagram
// against the surface it is ACTUALLY painted on in the app, not an adjacent Mermaid-internal
// approximation of it.
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
// A11y/quality-gate remediation (HIGH, shared with check-theme-contrast.mjs's own sister fix):
// the `.theme-<id>` block/property regexes below match raw text with no comment-awareness, so a
// `--token: value;`-shaped line sitting INSIDE a `/* ... */` CSS comment would otherwise silently
// parse as if it were live. Strip every comment first, and fail loudly if stripping leaves an
// unbalanced or unterminated marker behind.
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
// Quality-gate remediation: `--card` can now be `var(--surface-1)` (the three-layer token model,
// #550) rather than a literal `oklch()`/hex value. The old version here matched only a literal
// and silently skipped any theme whose `--card` didn't match, which made the cardColor fallback
// below (`REAL_CARD_COLORS[themeId] || themeVariables.primaryColor`) quietly substitute Mermaid's
// own unrelated `primaryColor` stand-in -- exactly the drift round 6's own header comment says
// this file exists to prevent. This resolves one or more `var(--name)` hops per theme (same
// algorithm as check-theme-contrast.mjs's own `resolveRawValue`, duplicated rather than shared --
// see that script's header for why these two one-off scripts don't import from each other) before
// matching a literal colour, and a theme whose `--card` still can't be resolved is a hard failure
// below, never a silent fallback.
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
// Quality-gate remediation (security review, LOW): `Object.create(null)` rather than `{}`,
// matching check-theme-contrast.mjs's own sister resolver -- a theme block that writes
// `var(--constructor)` (or another `Object.prototype` name) the block itself never defines
// would otherwise return a function from a plain-object lookup, and `.match` on it throws
// instead of the intended clear "cannot resolve --card" hard failure.
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

// ---- stage a scratch dir: harness HTML (imports the real installed mermaid package and this
// repo's own real-DOM measurement module) + a generated Electron main script that renders every
// diagram/theme pair and dumps JSON -----------------------------------------------------------

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

  // Import the app's own real theme-variable AND themeCSS source (src/shared/mermaidTheme.ts) with
  // Node's built-in TypeScript support: copied to a `.mts` path so Node treats it as ESM+TS
  // regardless of this package's own `"type": "commonjs"`. This is the SAME module Markdown.tsx's
  // `MermaidBlock` imports -- not a hand-copied duplicate that could silently drift from it.
  // Gate-fix (#1074 round 1, discovered live): `mermaidTheme.ts` imports its own per-theme DATA
  // from a sibling module, `./mermaidThemeData` (extracted out in #551/#806's file-size ratchet
  // follow-up, after this script was last written) -- Node's native TS-stripping resolver needs
  // an explicit extension for a relative specifier, so copying only `mermaidTheme.ts` left this
  // script unable to even IMPORT its own subject (`ERR_MODULE_NOT_FOUND`), the real reason every
  // `nordic-frost`/`cyber-amber` comment in `mermaidThemeData.ts` has called this check "deferred
  // to this lane's build slot" ever since -- it was not merely unrun, it could never have run.
  // `mermaidThemeData.ts` itself has no runtime imports (its two `import type` lines are erased
  // by TS stripping), so copying it alongside and rewriting `mermaidTheme.mts`'s own specifier to
  // the copy's real `.mts` extension is enough; no further transitive files are needed.
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

  // Hard failure, not the old `REAL_CARD_COLORS[themeId] || themeVariables.primaryColor`
  // fallback: every theme `MERMAID_THEME_VARIABLES` declares must have a real, resolvable
  // `--card` in globals.css, or every pie-slice-vs-card and shape check below is silently
  // measured against the wrong backdrop.
  const unresolvedCardThemes = Object.keys(MERMAID_THEME_VARIABLES).filter((themeId) => !realCardColors[themeId])
  if (unresolvedCardThemes.length > 0) {
    throw new Error(
      `check-mermaid-contrast: --card could not be resolved to a real colour for: ${unresolvedCardThemes.join(', ')} ` +
      `(globals.css's .theme-<id> block is missing --card, or it is a var() chain this script's resolver can't follow). ` +
      `Refusing to fall back to Mermaid's own primaryColor stand-in.`
    )
  }

  // Quality-gate remediation (round 6): `force-device-scale-factor=1` makes every CSS pixel this
  // harness measures (`getBoundingClientRect`, `window.innerWidth`/`innerHeight`) map 1:1 onto the
  // real pixel buffer `webContents.capturePage()` returns below, regardless of this host's own OS
  // display-scaling setting -- verified against a real capture (red square at a known CSS rect
  // landed at the identical pixel offset in the captured bitmap, with `image.getSize()` matching
  // `window.innerWidth`/`innerHeight` exactly) before relying on it for the per-pixel glyph/
  // background diffing `measureTextFromScreenshots` below performs.
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

  // `require('electron')` resolves to the real electron.exe path on disk (works cross-platform
  // without a shell, unlike the node_modules/.bin/electron.cmd shim).
  const electronBin = (await import('electron')).default
  await execFileAsync(electronBin, [mainPath, '--no-sandbox'], { cwd: repoRoot, timeout: 90_000 })

  const results = JSON.parse(readFileSync(path.join(workDir, 'results.json'), 'utf-8'))

  // ---- assemble the check table + MIN_CHECKS_PER_DIAGRAM gate ---------------------------------

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

  // ---- print the table -------------------------------------------------------------------------

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
