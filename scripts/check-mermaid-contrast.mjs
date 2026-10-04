#!/usr/bin/env node
// Verifies every built-in theme's Mermaid diagram colours for real, measured contrast, rendered
// with the REAL pinned mermaid@11.17.2 package inside a real Chromium renderer (Electron -- the
// same engine the app itself uses for `MermaidBlock`), not a mock. Companion to
// check-theme-contrast.mjs (which checks the app's own CSS tokens only): this script exists
// because Mermaid computes several diagram colours (pie slices, mindmap/timeline/journey section
// fills, Gantt text-on-overflow) from theme variables via its own internal derivation logic,
// which a static CSS-token check cannot see -- only a real render can.
//
// Quality-gate remediation (High, round 2): added after two review rounds missed exactly these
// derived-colour failures (`theme: 'base'` -> `theme: 'dark'` switch, see src/shared/
// mermaidTheme.ts's own comment) because every prior check here was a human reviewer eyeballing
// one diagram type at a time. This script renders every diagram type this app's MermaidBlock
// supports, for every theme in MERMAID_THEME_VARIABLES, and asserts measured WCAG contrast ratios
// so a future regression here fails `pnpm check:mermaid-contrast` instead of needing a human to
// notice it diagram-by-diagram again.
//
// Usage: node scripts/check-mermaid-contrast.mjs
// Exits 1 if any pair fails its minimum, 0 if every pair across every theme/diagram passes.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

// ---- hex contrast helpers (same WCAG formulas as check-theme-contrast.mjs, hex-only here since
// Mermaid's rendered SVGs resolve every colour to hex/hsl directly, no oklch/alpha involved) -----

function srgbToLinear(c) {
  c /= 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
function hexToRgb(hex) {
  hex = hex.replace('#', '')
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('')
  const n = parseInt(hex, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function hslToHex(h, s, l) {
  s /= 100
  l /= 100
  const k = (n) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  const r = Math.round(255 * f(0))
  const g = Math.round(255 * f(8))
  const b = Math.round(255 * f(4))
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')
}
/** Accepts a hex literal or an `hsl(h, s%, l%)` string, both of which Mermaid's rendered SVGs use. */
function toHex(color) {
  const hslMatch = /^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i.exec(color)
  if (hslMatch) return hslToHex(Number(hslMatch[1]), Number(hslMatch[2]), Number(hslMatch[3]))
  return color
}
function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrastRatio(hexA, hexB) {
  const lumA = relativeLuminance(toHex(hexA))
  const lumB = relativeLuminance(toHex(hexB))
  const hi = Math.max(lumA, lumB)
  const lo = Math.min(lumA, lumB)
  return (hi + 0.05) / (lo + 0.05)
}

// ---- diagram fixtures: one per diagram type MermaidBlock actually renders ---------------------

const DIAGRAMS = {
  flowchart: `flowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Do thing]\n  B -->|No| D[Other thing]\n`,
  sequence: `sequenceDiagram\n  participant Alice\n  participant Bob\n  Alice->>Bob: Hello\n  Note over Alice,Bob: a note\n  Bob-->>Alice: Hi\n`,
  er: `erDiagram\n  CUSTOMER {\n    string name\n    string id\n    string email\n  }\n  CUSTOMER ||--o{ ORDER : places\n`,
  gantt: `gantt\n  title A Gantt Diagram\n  dateFormat YYYY-MM-DD\n  excludes weekends\n  section Section\n  Done task :done, des1, 2024-01-06,2024-01-08\n  Active task :active, des2, 2024-01-09, 3d\n  Critical task :crit, des3, after des2, 5d\n  Future task :des4, after des3, 5d\n`,
  pie: `pie title Pets\n  "Dogs" : 40\n  "Cats" : 30\n  "Birds" : 20\n  "Fish" : 10\n`,
  mindmap: `mindmap\n  root((Root))\n    A\n      A1\n      A2\n    B\n      B1\n`,
  xychart: `xychart-beta\n  title "Sales"\n  x-axis [jan, feb, mar, apr]\n  y-axis "Revenue" 0 --> 100\n  bar [20, 40, 60, 80]\n  line [10, 30, 50, 70]\n`
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

  function record(themeId, diagramType, label, fgHex, bgHex, min) {
    const ratio = contrastRatio(fgHex, bgHex)
    const pass = ratio >= min
    if (!pass) failCount++
    rows.push({ themeId, diagramType, label, ratio, min, pass, fgHex: toHex(fgHex), bgHex: toHex(bgHex) })
  }

  for (const [themeId, diagrams] of Object.entries(results)) {
    const bg = MERMAID_THEME_VARIABLES[themeId].background
    for (const [diagramType, result] of Object.entries(diagrams)) {
      if (!result.ok) {
        rows.push({ themeId, diagramType, label: 'render', ratio: null, min: null, pass: false, note: result.error })
        failCount++
        continue
      }
      const svg = result.svg
      const styleMatch = svg.match(/<style>([\s\S]*?)<\/style>/)
      const style = styleMatch ? styleMatch[1] : ''

      if (diagramType === 'pie') {
        const sliceFills = [...svg.matchAll(/<path[^>]*fill="(#[0-9a-fA-F]{3,6})"[^>]*class="pieCircle"/g)].map(
          (m) => m[1]
        )
        sliceFills.forEach((fill, i) => record(themeId, diagramType, `slice ${i} vs background`, fill, bg, 3))
        const textFillMatch = style.match(/\.slice\{[^}]*fill:\s*([^;}]+)/)
        if (textFillMatch && sliceFills.length > 0) {
          sliceFills.forEach((fill, i) =>
            record(themeId, diagramType, `slice ${i} % label text`, textFillMatch[1], fill, 4.5)
          )
        }
      }

      if (diagramType === 'mindmap') {
        // Only check sections a real node actually uses in this diagram (Mermaid emits
        // boilerplate CSS for every section index up to its colour-scale limit regardless of
        // how many the diagram actually needs -- checking unused indices would be a false
        // positive, not a real contrast bug).
        const usedSections = new Set(
          [...svg.matchAll(/class="node mindmap-node section-(\d+)"/g)].map((m) => Number(m[1]))
        )
        for (const i of usedSections) {
          const fillMatch = style.match(new RegExp(`\\.section-${i}\\s+rect,[^{]*\\{[^}]*fill:\\s*([^;}]+)`))
          const textMatch = style.match(new RegExp(`\\.section-${i}\\s+text\\{[^}]*fill:\\s*([^;}]+)`))
          if (fillMatch && textMatch) {
            record(themeId, diagramType, `section-${i} text on fill`, textMatch[1], fillMatch[1], 4.5)
          }
        }
      }

      if (diagramType === 'gantt') {
        const outsideMatch = style.match(/\.taskTextOutsideRight\{fill:([^;}]+)/)
        if (outsideMatch) record(themeId, diagramType, 'overflow task label vs background', outsideMatch[1], bg, 4.5)
        const clickableMatch = style.match(/\.taskText\.clickable\{[^}]*fill:\s*([^;}]+?)!important/)
        if (clickableMatch) record(themeId, diagramType, 'clickable task label vs background', clickableMatch[1], bg, 4.5)
        const critMatch = style.match(/\.crit0,[^{]*\{[^}]*fill:\s*([^;}]+)/)
        if (critMatch) record(themeId, diagramType, 'crit task bar vs background', critMatch[1], bg, 3)
        const excludeMatch = style.match(/\.exclude-range\{fill:([^;}]+)\}/)
        if (excludeMatch) record(themeId, diagramType, 'exclude-range band vs background', excludeMatch[1], bg, 3)
        const todayMatch = style.match(/\.today\{[^}]*stroke:([^;}]+)/)
        if (todayMatch) record(themeId, diagramType, 'today line vs background', todayMatch[1], bg, 3)
      }
    }
  }

  // ---- print the table -------------------------------------------------------------------------

  const header = ['theme', 'diagram', 'check', 'ratio', 'min', 'result']
  const widths = [18, 10, 34, 8, 5, 6]
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
