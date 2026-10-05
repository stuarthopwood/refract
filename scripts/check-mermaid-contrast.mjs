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
 // below still exercises the same real rendered band/colour either way.
 gantt: `gantt\n  title A Gantt Diagram\n  dateFormat YYYY-MM-DD\n  excludes 2024-02-10,2024-02-11\n  section Overflow\n  Done task with a very long label that overflows :done, o1, 2024-01-08, 1d\n  Active task with a very long label that overflows :active, o2, after o1, 1d\n  Critical task with a very long label that overflows :crit, o3, after o2, 1d\n  Active critical task with a very long label that overflows :active, crit, o3b, after o3, 1d\n  Future task with a very long label that overflows :o4, after o3b, 1d\n  section Inside\n  D :done, i1, 2024-02-01, 20d\n  A :active, i2, after i1, 20d\n  C :crit, i3, after i2, 20d\n`,
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
import { run } from './mermaid-contrast-measure.mjs'
window.__mermaid = mermaid
window.__run = run
window.__ready = true
</script></body></html>`
 )

 // Import the app's own real theme-variable AND themeCSS source (src/shared/mermaidTheme.ts) with
 // Node's built-in TypeScript support: copied to a `.mts` path so Node treats it as ESM+TS
 // regardless of this package's own `"type": "commonjs"`. This is the SAME module Markdown.tsx's
 // `MermaidBlock` imports -- not a hand-copied duplicate that could silently drift from it.
 const tsSourcePath = path.join(repoRoot, 'src/shared/mermaidTheme.ts')
 const mtsPath = path.join(workDir, 'mermaidTheme.mts')
 cpSync(tsSourcePath, mtsPath)
 const { MERMAID_THEME_VARIABLES, getMermaidThemeCSS } = await import(pathToFileURL(mtsPath).href)

 const themeCSSByTheme = Object.fromEntries(
  Object.keys(MERMAID_THEME_VARIABLES).map((themeId) => [themeId, getMermaidThemeCSS(themeId)])
 )

 const mainScript = `
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
app.disableHardwareAcceleration()
const THEMES = ${JSON.stringify(MERMAID_THEME_VARIABLES)}
const THEME_CSS = ${JSON.stringify(themeCSSByTheme)}
const DIAGRAMS = ${JSON.stringify(DIAGRAMS)}
async function main() {
  // Generous viewport: Gantt/timeline/gitGraph fixtures render far wider/taller than Electron's
  // 800x600 default, and any element positioned outside the viewport is unreachable by
  // \`elementsFromPoint\`/\`getBoundingClientRect\`-based sampling below -- silently dropping real
  // checks rather than failing them, the exact round-4 failure mode this round replaced.
  const win = new BrowserWindow({ show: false, width: 3000, height: 4000, webPreferences: { contextIsolation: false } })
  await win.loadFile(${JSON.stringify(path.join(workDir, 'harness.html'))})
  await win.webContents.executeJavaScript('new Promise(r => { const i = setInterval(() => { if (window.__ready) { clearInterval(i); r(true) } }, 20) })')
  const results = {}
  for (const [themeId, themeVariables] of Object.entries(THEMES)) {
    results[themeId] = {}
    const cardColor = themeVariables.primaryColor
    const themeCSS = THEME_CSS[themeId]
    for (const [diagramType, code] of Object.entries(DIAGRAMS)) {
      const args = { themeVariables, themeCSS, code, cardColor, diagramType }
      results[themeId][diagramType] = await win.webContents.executeJavaScript('window.__run(' + JSON.stringify(args) + ')')
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
    rows.push({ themeId, diagramType, label: check.label, ratio: check.ratio, min: check.min, pass: check.pass })
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
