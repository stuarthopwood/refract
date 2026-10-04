#!/usr/bin/env node
// Verifies every built-in theme's Mermaid diagram colours for real, measured contrast, rendered
// with the REAL pinned mermaid@11.17.2 package inside a real Chromium renderer (Electron -- the
// same engine the app itself uses for `MermaidBlock`), not a mock. Companion to
// check-theme-contrast.mjs (which checks the app's own CSS tokens only): this script exists
// because Mermaid computes several diagram colours (pie slices, mindmap/timeline section fills,
// Gantt text-on-bar/overflow, journey/gitGraph fills) from theme variables via its own internal
// derivation logic, which a static CSS-token check cannot see -- only a real render can.
//
// Quality-gate remediation (High, round 2): added after two review rounds missed exactly these
// derived-colour failures (`theme: 'base'` -> `theme: 'dark'` switch, see src/shared/
// mermaidTheme.ts's own comment) because every prior check here was a human reviewer eyeballing
// one diagram type at a time. This script renders every diagram type this app's MermaidBlock
// supports, for every theme in MERMAID_THEME_VARIABLES, and asserts measured WCAG contrast ratios
// so a future regression here fails `pnpm check:mermaid-contrast` instead of needing a human to
// notice it diagram-by-diagram again.
//
// Quality-gate remediation (round 4): this script's OWN methodology had three real gaps that let
// two High regressions through undetected (28/28 PASS here, 18/74 FAIL against a reviewer's
// enhanced out-of-repo harness with more realistic fixtures):
// 1. Every `diagramType === 'x'` block only ran a check `if (someRegex.match(...))` -- a silent
//    skip, not a failure, when Mermaid's rendered markup shape changed even slightly, with only a
//    whole-run `rows.length === 0` guard. Every check below instead declares, per diagram type,
//    the MINIMUM number of checks it expects to resolve (`MIN_CHECKS_PER_DIAGRAM`); after the
//    render loop, any diagram type that resolved FEWER checks than declared is a hard FAILURE
//    (`insufficient checks resolved`), not silence. The mindmap regex specifically also excluded
//    the root node (`section--1`, which a `\d+`-only regex can't match) -- fixed to `-?\d+`.
// 2. Contrast was measured against `themeVariables.background` (this app's `--background`), but
//    `Markdown.tsx`'s `MermaidBlock` actually displays the rendered diagram as an `<img>` sitting
//    on a `bg-card` div -- a LIGHTER real surface. Every ratio reported here was therefore higher
//    than what actually renders (confirmed: a crit bar measured 4.74:1 against `background` but
//    only 3.95:1 against the real `--card` surface). Every check below measures against
//    `themeVariables.primaryColor` instead (this app's own `--card` value, per that key's
//    interface comment in mermaidTheme.ts) -- the one exception is xychart, which Mermaid paints
//    with its own literal `<rect class="background">` fill, so that check compares the rendered
//    bar colour against that SAME rendered rect, not a separate assumption.
// 3. Four diagram types MermaidBlock actually renders (timeline, journey, gitGraph, and the
//    fixtures for pie/mindmap) had either zero fixtures or zero assertions at all, and
//    flowchart/sequence/er/xychart were rendered but nothing was ever checked on them despite a
//    (now-corrected) mermaidTheme.ts comment claiming they were "measured correctly". Every
//    diagram type MermaidBlock supports now has both a fixture and at least one real assertion.
// The pie/mindmap fixtures were also widened from 4/2 slices-and-branches to 12/11 -- Mermaid's
// own `THEME_COLOR_LIMIT = 12` -- since the two round-4 regressions only showed up past slot 8,
// which the old 4- and 2-entry fixtures could never reach.
//
// Usage: node scripts/check-mermaid-contrast.mjs
// Exits 1 if any pair fails its minimum, 0 if every pair across every theme/diagram passes.

import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

// ---- hex contrast helpers (same WCAG formulas as check-theme-contrast.mjs, hex-only here since
// Mermaid's rendered SVGs resolve every colour to hex/hsl directly, no oklch/alpha involved) -----

function srgbToLinear(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
function hexToRgb(hex) { hex = hex.replace('#', ''); if (hex.length === 3) hex = hex.split('').map((c) => c + c).join(''); const n = parseInt(hex, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
function hslToHex(h, s, l) { s /= 100; l /= 100; const k = (n) => (n + h / 30) % 12; const a = s * Math.min(l, 1 - l); const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return '#' + [f(0), f(8), f(4)].map((x) => Math.round(255 * x).toString(16).padStart(2, '0')).join('') }
// Round 4: Mermaid's own shipped CSS defaults fall back to CSS named colours for several
// variables this file doesn't override (gitGraph's `commitLabelColor`, Gantt's
// `doneTaskBorderColor`, sequence's `sequenceNumberColor`) -- `toHex` silently passed these
// through unresolved before, so `contrastRatio` fed `parseInt('lightgrey', 16)` (`NaN`) into a
// luminance formula and produced a meaningless ratio instead of either a real number or a loud
// failure. Named colours Mermaid's shipped `theme-dark.js`/diagram styles actually use.
const CSS_NAMED_COLORS = {
 black: '#000000', white: '#ffffff', grey: '#808080', gray: '#808080',
 lightgrey: '#d3d3d3', lightgray: '#d3d3d3', darkgrey: '#a9a9a9', darkgray: '#a9a9a9',
 navy: '#000080', lightblue: '#add8e6', pink: '#ffc0cb', red: '#ff0000',
 green: '#008000', blue: '#0000ff', yellow: '#ffff00', orange: '#ffa500',
 transparent: '#00000000', none: '#00000000'
}
/** Accepts a hex literal, an `hsl(h, s%, l%)` string, or a CSS named colour -- all of which
 * Mermaid's rendered SVGs use somewhere. */
function toHex(color) {
 const named = CSS_NAMED_COLORS[color.trim().toLowerCase()]
 if (named) return named
 const hslMatch = /^hsl\(\s*(-?[\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/.exec(color)
 if (!hslMatch) return color
 return hslToHex(Number(hslMatch[1]), Number(hslMatch[2]), Number(hslMatch[3]))
}
function relativeLuminance(hex) { const [r, g, b] = hexToRgb(hex); return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b) }
function contrastRatio(hexA, hexB) { const lumA = relativeLuminance(toHex(hexA)); const lumB = relativeLuminance(toHex(hexB)); const hi = Math.max(lumA, lumB); const lo = Math.min(lumA, lumB); return (hi + 0.05) / (lo + 0.05) }

// ---- diagram fixtures: one per diagram type MermaidBlock actually renders ---------------------
// (round 4: pie/mindmap widened to 12/11 to reach Mermaid's own 12-slot colour-scale limit;
// gantt split into an "Overflow" section -- long labels on short default-width bars, exercising
// the outside-the-bar text path -- and an "Inside" section -- short labels on long 20-day bars,
// exercising the inside-the-bar text path that round 2/3's fixture never reached; timeline/
// journey/gitGraph added from zero.)

const DIAGRAMS = {
 flowchart: `flowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Do thing]\n  B -->|No| D[Other thing]\n`,
 sequence: `sequenceDiagram\n  participant Alice\n  participant Bob\n  Alice->>Bob: Hello\n  Note over Alice,Bob: a note\n  Bob-->>Alice: Hi\n`,
 er: `erDiagram\n  CUSTOMER {\n    string name\n    string id\n    string email\n  }\n  CUSTOMER ||--o{ ORDER : places\n`,
 gantt: `gantt\n  title A Gantt Diagram\n  dateFormat YYYY-MM-DD\n  excludes weekends\n  section Overflow\n  Done task with a very long label that overflows :done, o1, 2024-01-06, 1d\n  Active task with a very long label that overflows :active, o2, after o1, 1d\n  Critical task with a very long label that overflows :crit, o3, after o2, 1d\n  Future task with a very long label that overflows :o4, after o3, 1d\n  section Inside\n  D :done, i1, 2024-02-01, 20d\n  A :active, i2, after i1, 20d\n  C :crit, i3, after i2, 20d\n`,
 pie: `pie title Twelve\n${Array.from({ length: 12 }, (_, i) => `  "S${i}" : ${i + 1}`).join('\n')}\n`,
 mindmap: `mindmap\n  root((Root))\n${Array.from({ length: 11 }, (_, i) => `    B${i}`).join('\n')}\n`,
 xychart: `xychart-beta\n  title "Sales"\n  x-axis [jan, feb, mar, apr]\n  y-axis "Revenue" 0 --> 100\n  bar [20, 40, 60, 80]\n  line [10, 30, 50, 70]\n`,
 timeline: `timeline\n  title Multi-section\n  section One\n    2020 : A : B\n  section Two\n    2021 : C : D\n  section Three\n    2022 : E : F\n  section Four\n    2023 : G : H\n`,
 journey: `journey\n  title My day\n  section Morning\n    Wake up: 5: Me\n    Coffee: 3: Me\n  section Evening\n    Sleep: 4: Me\n`,
 gitGraph: `gitGraph\n  commit\n  branch develop\n  checkout develop\n  commit\n  checkout main\n  merge develop\n`
}

// ---- per-diagram-type minimum resolved-check counts (round 4): an actual count BELOW this is a
// hard FAILURE ("insufficient checks resolved"), never a silent skip. Each diagram type's fixture
// above is sized to clear its own minimum; a Mermaid markup-shape change that stops a regex from
// matching now fails loudly instead of quietly shrinking the table. -------------------------------

const MIN_CHECKS_PER_DIAGRAM = {
 flowchart: 1,
 sequence: 1,
 er: 1,
 gantt: 8,
 pie: 36, // 12 slices x (vs card, % label text, stroke vs slice)
 mindmap: 12, // section--1 (root) through section-10
 xychart: 1,
 timeline: 4, // >=1 section fill, >=1 section text, axis line, >=1 connector line
 journey: 1,
 gitGraph: 1
}

// ---- stage a scratch dir: harness HTML (imports the real installed mermaid package) + a
// generated Electron main script that renders every diagram/theme pair and dumps JSON ------------

const workDir = mkdtempSync(path.join(tmpdir(), 'pinion-mermaid-contrast-'))
try {
 const mermaidEntry = pathToFileURL(
  path.join(repoRoot, 'node_modules/mermaid/dist/mermaid.esm.min.mjs')
 ).href
 writeFileSync(
  path.join(workDir, 'harness.html'),
  `<!DOCTYPE html><html><body><script type="module">
import mermaid from '${mermaidEntry}'
window.__mermaid = mermaid
window.__ready = true
</script></body></html>`
 )

 // Import the app's own real theme-variable source (src/shared/mermaidTheme.ts) with Node's
 // built-in TypeScript support: copied to a `.mts` path so Node treats it as ESM+TS regardless
 // of this package's own `"type": "commonjs"`. This is the SAME object MermaidBlock.tsx passes
 // to `mermaid.initialize()` -- not a hand-copied duplicate that could silently drift from it.
 const tsSourcePath = path.join(repoRoot, 'src/shared/mermaidTheme.ts')
 const mtsPath = path.join(workDir, 'mermaidTheme.mts')
 cpSync(tsSourcePath, mtsPath)
 const { MERMAID_THEME_VARIABLES } = await import(pathToFileURL(mtsPath).href)

 const mainScript = `
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
app.disableHardwareAcceleration()
const THEMES = ${JSON.stringify(MERMAID_THEME_VARIABLES)}
const DIAGRAMS = ${JSON.stringify(DIAGRAMS)}
async function main() {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false } })
  await win.loadFile(${JSON.stringify(path.join(workDir, 'harness.html'))})
  await win.webContents.executeJavaScript('new Promise(r => { const i = setInterval(() => { if (window.__ready) { clearInterval(i); r(true) } }, 20) })')
  const results = {}
  for (const [themeId, themeVariables] of Object.entries(THEMES)) {
    results[themeId] = {}
    for (const [diagramType, code] of Object.entries(DIAGRAMS)) {
      const script = \`
        (async () => {
          const mermaid = window.__mermaid
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            suppressErrorRendering: true,
            theme: 'dark',
            themeVariables: \${JSON.stringify(themeVariables)}
          })
          try {
            const rendered = await mermaid.render('mmd-\${themeId.replace(/[^a-z]/g, '')}-\${diagramType}', \${JSON.stringify(code)})
            return { ok: true, svg: rendered.svg }
          } catch (err) {
            return { ok: false, error: String(err && err.message || err) }
          }
        })()
      \`
      results[themeId][diagramType] = await win.webContents.executeJavaScript(script)
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
 await execFileAsync(electronBin, [mainPath, '--no-sandbox'], { cwd: repoRoot, timeout: 60_000 })

 const results = JSON.parse(readFileSync(path.join(workDir, 'results.json'), 'utf-8'))

 // ---- extract resolved colours from each rendered SVG and assert contrast -------------------

 const rows = []
 let failCount = 0
 const checksByDiagram = {} // themeId -> diagramType -> count, for the MIN_CHECKS_PER_DIAGRAM gate

 function record(themeId, diagramType, label, fgHex, bgHex, min) {
  const ratio = contrastRatio(fgHex, bgHex)
  const pass = ratio >= min
  if (!pass) failCount++
  rows.push({ themeId, diagramType, label, ratio, min, pass, fgHex: toHex(fgHex), bgHex: toHex(bgHex) })
  checksByDiagram[themeId] ??= {}
  checksByDiagram[themeId][diagramType] = (checksByDiagram[themeId][diagramType] ?? 0) + 1
 }

 for (const [themeId, diagrams] of Object.entries(results)) {
  // Round 4: measure against the theme's own `--card` value (`primaryColor`), the REAL surface
  // `Markdown.tsx` renders the diagram `<img>` on top of (`bg-card`), not `background` (the
  // app's `--background`, a darker surface the diagram is never actually displayed against).
  const card = MERMAID_THEME_VARIABLES[themeId].primaryColor
  for (const [diagramType, result] of Object.entries(diagrams)) {
   if (!result.ok) {
    rows.push({ themeId, diagramType, label: 'render', ratio: null, min: null, pass: false, note: result.error })
    failCount++
    continue
   }
   const svg = result.svg
   const styleMatch = svg.match(/<style>([\s\S]*?)<\/style>/)
   const style = styleMatch ? styleMatch[1] : ''

   if (diagramType === 'flowchart') {
    const fillMatch = style.match(/\.node rect,[^{]*\{[^}]*fill:\s*([^;}]+)/)
    const textMatch = style.match(/\.label text,[^{]*\{[^}]*fill:\s*([^;}]+)/)
    if (fillMatch && textMatch) record(themeId, diagramType, 'node label text vs node fill', textMatch[1], fillMatch[1], 4.5)
   }

   if (diagramType === 'sequence') {
    const noteFillMatch = style.match(/\.note\{[^}]*fill:\s*([^;}]+)/)
    const noteTextMatch = style.match(/\.noteText,[^{]*\{[^}]*fill:\s*([^;}]+)/)
    if (noteFillMatch && noteTextMatch) record(themeId, diagramType, 'note text vs note fill', noteTextMatch[1], noteFillMatch[1], 4.5)
   }

   if (diagramType === 'er') {
    const entityFillMatch = style.match(/\.entityBox\{[^}]*fill:\s*([^;}]+)/)
    if (entityFillMatch) record(themeId, diagramType, 'entity title text vs entity fill', MERMAID_THEME_VARIABLES[themeId].textColor, entityFillMatch[1], 4.5)
   }

   if (diagramType === 'xychart') {
    const bgRectMatch = svg.match(/<rect[^>]*class="background"[^>]*fill="([^"]+)"/)
    const barMatch = svg.match(/<rect[^>]*fill="(#[0-9a-fA-F]{3,6})"[^>]*stroke="\1"/)
    if (bgRectMatch && barMatch) record(themeId, diagramType, 'bar fill vs xychart background', barMatch[1], bgRectMatch[1], 3)
   }

   if (diagramType === 'pie') {
    const sliceFills = [...svg.matchAll(/<path[^>]*fill="(#[0-9a-fA-F]{3,6})"[^>]*class="pieCircle"/g)].map((m) => m[1])
    sliceFills.forEach((fill, i) => record(themeId, diagramType, `slice ${i} vs card`, fill, card, 3))
    const textFillMatch = style.match(/\.slice\{[^}]*fill:\s*([^;}]+)/)
    const strokeMatch = style.match(/\.pieCircle\{[^}]*stroke:\s*([^;}]+)/)
    if (textFillMatch) sliceFills.forEach((fill, i) => record(themeId, diagramType, `slice ${i} % label text`, textFillMatch[1], fill, 4.5))
    // Round 4: slices are distinguished by hue alone for colour-blind viewers -- the
    // separating stroke itself must independently clear 3:1 against every slice it borders.
    if (strokeMatch) sliceFills.forEach((fill, i) => record(themeId, diagramType, `slice ${i} stroke vs slice`, strokeMatch[1], fill, 3))
   }

   if (diagramType === 'mindmap') {
    // Only check sections a real node actually uses in this diagram (Mermaid emits
    // boilerplate CSS for every section index up to its colour-scale limit regardless of
    // how many the diagram actually needs -- checking unused indices would be a false
    // positive, not a real contrast bug). Round 4: `-?\d+` so the root node (`section--1`)
    // is included, not silently skipped by a `\d+`-only pattern.
    const usedSections = new Set(
     [...svg.matchAll(/class="[^"]*\bsection-(-?\d+)"/g)].map((m) => Number(m[1]))
    )
    for (const i of usedSections) {
     const fillMatch = style.match(new RegExp(`\\.section-${i}\\s+rect,[^{]*\\{[^}]*fill:\\s*([^;}]+)`))
     const textMatch = style.match(new RegExp(`\\.section-${i}\\s+text\\{[^}]*fill:\\s*([^;}]+)`))
     if (fillMatch && textMatch) {
      record(themeId, diagramType, `section-${i} text on fill`, textMatch[1], fillMatch[1], 4.5)
     }
    }
   }

   if (diagramType === 'timeline') {
    const usedSections = new Set(
     [...svg.matchAll(/class="timeline-node section-(-?\d+)"/g)].map((m) => Number(m[1]))
    )
    for (const i of usedSections) {
     const fillMatch = style.match(new RegExp(`\\.section-${i} rect,[^{]*\\{[^}]*fill:\\s*([^;}]+)`))
     const textMatch = style.match(new RegExp(`\\.section-${i} text\\{[^}]*fill:\\s*([^;}]+)`))
     if (fillMatch) record(themeId, diagramType, `section-${i} fill vs card`, fillMatch[1], card, 3)
     if (fillMatch && textMatch) record(themeId, diagramType, `section-${i} text on fill`, textMatch[1], fillMatch[1], 4.5)
     const connectorMatch = style.match(new RegExp(`\\.section-${i} line\\{stroke:\\s*([^;}]+)`))
     if (connectorMatch) record(themeId, diagramType, `section-${i} connector line vs card`, connectorMatch[1], card, 3)
    }
    // Round 4: Mermaid's own `.lineWrapper line` rule is regenerated once per colour-scale
    // slot with the SAME selector, so only the LAST slot's value actually wins the cascade --
    // `style.match` (first match, not matchAll) would find the WRONG (overwritten) one, so
    // take the last occurrence explicitly.
    const axisLineMatches = [...style.matchAll(/\.lineWrapper line\{[^}]*stroke:\s*([^;}]+)/g)]
    if (axisLineMatches.length > 0) {
     record(themeId, diagramType, 'time axis line vs card', axisLineMatches[axisLineMatches.length - 1][1], card, 3)
    }
   }

   if (diagramType === 'journey') {
    const fillMatches = [...style.matchAll(/\.task-type-(\d+), ?#[\w-]+ \.section-type-\d\{\s*fill:\s*([^;}]+)/g)]
    for (const m of fillMatches) {
     record(themeId, diagramType, `task-type-${m[1]} fill vs card`, m[2], card, 3)
     // Mermaid's shipped `user-journey/styles.js` hardcodes `.label text { fill: #333 }`
     // with no theme-variable hook at all -- check what's ACTUALLY rendered on top of our
     // fill, not a variable we control, since this is exactly the pairing a real contrast
     // bug needs both halves of.
     record(themeId, diagramType, `task-type-${m[1]} hardcoded #333 label vs fill`, '#333333', m[2], 4.5)
    }
   }

   if (diagramType === 'gitGraph') {
    const commitMatch = style.match(/\.commit0\{[^}]*fill:\s*([^;}]+)/)
    if (commitMatch) record(themeId, diagramType, 'commit0 dot vs card', commitMatch[1], card, 3)
    const labelMatch = style.match(/\.commit-id,[^{]*\{[^}]*fill:\s*([^;}]+)/)
    if (labelMatch) record(themeId, diagramType, 'commit-id/branch-label text vs card', labelMatch[1], card, 4.5)
   }

   if (diagramType === 'gantt') {
    const clickableMatch = style.match(/\.taskText\.clickable\{[^}]*fill:\s*([^;}]+?)!important/)
    if (clickableMatch) record(themeId, diagramType, 'clickable task label vs card', clickableMatch[1], card, 4.5)
    const critBarMatch = style.match(/\.crit0,[^{]*\{[^}]*fill:\s*([^;}]+)/)
    if (critBarMatch) record(themeId, diagramType, 'crit task bar vs card', critBarMatch[1], card, 3)
    const excludeMatch = style.match(/\.exclude-range\{[^}]*fill:\s*([^;}]+)/)
    if (excludeMatch) record(themeId, diagramType, 'exclude-range band vs card', excludeMatch[1], card, 3)
    const todayMatch = style.match(/\.today\{[^}]*stroke:([^;}]+)/)
    if (todayMatch) record(themeId, diagramType, 'today line vs card', todayMatch[1], card, 3)

    // Round 4: the plain `.doneText0.taskTextOutsideRight` combinator (NOT the generic,
    // lower-specificity `.taskTextOutsideRight` alone, which only applies to a plain task's
    // overflow) is what Mermaid actually renders for a DONE task's label once it spills
    // outside its own bar -- see mermaidTheme.ts's own header comment, point 1.
    const doneOverflowMatch = style.match(/\.doneText0\.taskTextOutsideRight,[^{]*\{[^}]*fill:\s*([^;}!]+)/)
    if (doneOverflowMatch) record(themeId, diagramType, 'done task overflow label vs card', doneOverflowMatch[1], card, 4.5)

    // Round 4: a SHORT label on a LONG done/active bar never spills outside, so it's the
    // plain (non-combinator) `.doneText0`/`.activeText0` rule that applies -- the inside-bar
    // case round 2/3's fixture never exercised. Paired against each bar's OWN fill colour,
    // not `card`, since that is what the text is actually drawn on top of.
    const doneInsideMatch = style.match(/\.doneText0,[^{]*\{[^}]*fill:\s*([^;}!]+)/)
    const doneBarMatch = style.match(/\.done0,[^{]*\{[^}]*fill:\s*([^;}]+)/)
    if (doneInsideMatch && doneBarMatch) record(themeId, diagramType, 'done task inside-bar label vs done bar', doneInsideMatch[1], doneBarMatch[1], 4.5)

    const activeInsideMatch = style.match(/\.activeText0,[^{]*\{[^}]*fill:\s*([^;}!]+)/)
    const activeBarMatch = style.match(/\.active0,[^{]*\{[^}]*fill:\s*([^;}]+)/)
    if (activeInsideMatch && activeBarMatch) record(themeId, diagramType, 'active task inside-bar label vs active bar', activeInsideMatch[1], activeBarMatch[1], 4.5)

    // Round 4: a plain (non-done, non-active) `:crit` task has no dedicated `.critText*` CSS
    // rule in Mermaid's shipped `gantt/styles.js` -- its inside label falls through to the
    // plain `.taskText0` rule (`taskTextColor`), paired against the plain crit bar's own fill
    // (`critBkgColor`), NOT `taskTextDarkColor` -- see mermaidTheme.ts's own header comment.
    const critInsideMatch = style.match(/\.taskText0,[^{]*\{[^}]*fill:\s*([^;}]+)/)
    if (critInsideMatch && critBarMatch) record(themeId, diagramType, 'plain crit task inside-bar label vs crit bar', critInsideMatch[1], critBarMatch[1], 4.5)
   }
  }
 }

 // ---- MIN_CHECKS_PER_DIAGRAM gate: a diagram type that resolved FEWER checks than declared is
 // a hard failure, never a silent skip (round 4). -------------------------------------------------

 for (const [themeId, diagrams] of Object.entries(results)) {
  for (const diagramType of Object.keys(diagrams)) {
   const expected = MIN_CHECKS_PER_DIAGRAM[diagramType] ?? 1
   const actual = checksByDiagram[themeId]?.[diagramType] ?? 0
   if (actual < expected) {
    rows.push({ themeId, diagramType, label: 'insufficient checks resolved', ratio: null, min: null, pass: false, note: `expected >=${expected}, resolved ${actual} -- a regex likely stopped matching Mermaid's rendered markup` })
    failCount++
   }
  }
 }

 // ---- print the table -------------------------------------------------------------------------

 const header = ['theme', 'diagram', 'check', 'ratio', 'min', 'result']
 const widths = [18, 10, 46, 8, 5, 6]
 const row = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join(' ')
 console.log(row(header))
 console.log(row(widths.map((w) => '-'.repeat(w))))
 for (const r of rows) {
  if (r.ratio === null) {
   console.log(row([r.themeId, r.diagramType, r.label, 'n/a', '-', 'FAIL']) + `  (${r.note})`)
   continue
  }
  console.log(
   row([r.themeId, r.diagramType, r.label, r.ratio.toFixed(2) + ':1', r.min, r.pass ? 'PASS' : 'FAIL']) +
   `  (${r.fgHex} on ${r.bgHex})`
  )
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
