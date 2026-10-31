import { contrastRatio, linearToHex, relativeLuminance, srgbGammaEncode } from './contrast-math.mjs'
// #456: contrast pairs for the Markdown, syntax and code-block tokens (globals.css), plus a drift
// check that each preset's `--mermaid-accent` matches its --accent-text.
// Same shape as PAIRS in theme-contrast-pairs.mjs: { fg, bg, min, onlyThemes? }.
const NON_HC = ['dark', 'obsidian', 'nordic-frost', 'cyber-amber']
const SYNTAX = ['syntax-keyword', 'syntax-function', 'syntax-string', 'syntax-constant', 'syntax-parameter', 'syntax-punctuation', 'syntax-comment', 'code-block-fg']

export const MARKDOWN_PAIRS = [
  { fg: 'md-heading', bg: 'background', min: 4.5 },
  { fg: 'md-heading', bg: 'card', min: 4.5 },
  { fg: 'md-marker', bg: 'background', min: 4.5 },
  { fg: 'md-marker', bg: 'card', min: 4.5 },
  { fg: 'md-quote-bar', bg: 'background', min: 3 },
  { fg: 'md-quote-bar', bg: 'card', min: 3 },
  { fg: 'md-code-label', bg: 'card', min: 4.5 },
  { fg: 'md-code-label', bg: 'code-block-bg', min: 4.5 },
  { fg: 'md-code-fg', bg: 'md-code-bg', min: 4.5 },
  { fg: 'md-code-fg', bg: 'background', min: 4.5 },
  { fg: 'md-code-fg', bg: 'card', min: 4.5 },
  { fg: 'md-table-header-fg', bg: 'muted', min: 4.5 },
  { fg: 'md-table-header-fg', bg: 'card', min: 4.5 },
  { fg: 'md-table-header-fg', bg: 'background', min: 4.5 },
  // Dark (high contrast): Markdown elements at 7:1.
  ...['md-heading', 'md-marker', 'md-code-label', 'md-code-fg', 'md-table-header-fg'].map((fg) => ({ fg, bg: 'card', min: 7, onlyThemes: ['dark-high-contrast'] })),
  ...SYNTAX.map((fg) => ({ fg, bg: 'code-block-bg', min: 4.5, onlyThemes: NON_HC })),
  ...SYNTAX.map((fg) => ({ fg, bg: 'card', min: 4.5, onlyThemes: NON_HC })),
  ...SYNTAX.map((fg) => ({ fg, bg: 'code-block-bg', min: 7, onlyThemes: ['dark-high-contrast'] })),
  ...SYNTAX.map((fg) => ({ fg, bg: 'card', min: 7, onlyThemes: ['dark-high-contrast'] })),
]

// Mermaid accent drift and contrast: accent == --accent-text (within rounding), accent stroke 3:1 on
// its tint fill and on --background, prose label 4.5:1 on the tint fill.
export function mermaidAccentRows(themes) {
  const rows = []
  let failCount = 0
  const add = (themeId, fg, bg, min, ratio, fgHex, bgHex) => {
    const pass = ratio >= min
    if (!pass) failCount++
    rows.push({ themeId, fg, bg, min, ratio, pass, fgHex, bgHex })
  }
  for (const [themeId, props] of Object.entries(themes)) {
    const at = props['accent-text']
    const accentTok = props['mermaid-accent']
    const fillTok = props['mermaid-accent-fill']
    if (!accentTok || !fillTok || !at || !props['background'] || !props['mermaid-node-fg']) {
      failCount++
      rows.push({ themeId, fg: 'mermaid accent', bg: 'accent-text', min: 1, ratio: null, pass: false, note: '--mermaid-accent/--mermaid-accent-fill or a token missing' })
      continue
    }
    const accent = linearToHex(accentTok.linear)
    const fill = linearToHex(fillTok.linear)
    const a = accentTok.linear
    const drift = Math.max(...a.map((v, i) => Math.abs(srgbGammaEncode(v) - srgbGammaEncode(at.linear[i]))))
    add(themeId, 'mermaid accent == accent-text (channel drift <= 2/255)', 'accent-text', 1, drift <= 2 / 255 ? 1 : 0, accent, linearToHex(at.linear))
    const fl = relativeLuminance(fillTok.linear)
    add(themeId, 'mermaid accent stroke', 'mermaid node fill', 3, contrastRatio(relativeLuminance(a), fl), accent, fill)
    add(themeId, 'mermaid accent stroke', 'background', 3, contrastRatio(relativeLuminance(a), relativeLuminance(props['background'].linear)), accent, linearToHex(props['background'].linear))
    add(themeId, 'mermaid-node-fg (node label)', 'mermaid node fill', 4.5, contrastRatio(relativeLuminance(props['mermaid-node-fg'].linear), fl), linearToHex(props['mermaid-node-fg'].linear), fill)
  }
  return { rows, checkedCount: rows.length, failCount }
}