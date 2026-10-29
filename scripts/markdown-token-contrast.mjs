// #456: contrast pairs for the Markdown, syntax and code-block tokens (globals.css), plus a drift
// check that each preset's Mermaid accent (src/shared/mermaidAccent.ts) matches its --accent-text.
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
]
