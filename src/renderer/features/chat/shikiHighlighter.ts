import type { Highlighter } from 'shiki'
import { createCssVariablesTheme, createHighlighter } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { CSS_VARIABLES_SYNTAX_THEME, THEMES } from '../../../shared/themes'

// #456: the presets that share the `css-variables` syntax theme take every token colour from the
// `--shiki-*` custom properties, which globals.css maps onto each theme's own `--syntax-*`
// tokens (so a theme's accent change carries through). Probed against shiki@4.4.3.
const cssVariablesTheme = createCssVariablesTheme({ name: CSS_VARIABLES_SYNTAX_THEME, variablePrefix: '--shiki-', variableDefaults: {}, fontStyle: true })

// One Shiki highlighter for the whole renderer, created lazily on first code block and reused.
// `createJavaScriptRegexEngine` avoids loading the WASM oniguruma engine in the sandboxed
// renderer (research.md decision 2, "Not verified": chosen for that reason, not benchmarked).
// Languages are loaded on demand, not bundled up front.
let highlighterPromise: Promise<Highlighter> | null = null
export function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({
    themes: [...new Set(Object.values(THEMES).map((theme) => theme.syntaxTheme))].map((name) =>
      name === CSS_VARIABLES_SYNTAX_THEME ? cssVariablesTheme : name
    ),
    langs: [],
    engine: createJavaScriptRegexEngine()
  })
  return highlighterPromise
}

// #975: a bundled Shiki theme's own fixed root background is neutralised via `colorReplacements`
// (keyed on the theme's own `.bg`) so the block shows `--code-block-bg`; the css-variables theme
// already paints `--shiki-background` (transparent), so it needs no replacement.
export function highlightToHtml(highlighter: Highlighter, code: string, lang: string, syntaxTheme: string): string {
  if (syntaxTheme === CSS_VARIABLES_SYNTAX_THEME) return highlighter.codeToHtml(code, { lang, theme: syntaxTheme })
  const themeBg = highlighter.getTheme(syntaxTheme).bg.toLowerCase()
  return highlighter.codeToHtml(code, { lang, theme: syntaxTheme, colorReplacements: { [themeBg]: 'transparent' } })
}
