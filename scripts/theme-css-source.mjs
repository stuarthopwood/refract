// Concatenates globals.css with the per-theme sheets in styles/themes/ (split out for the 600-line cap, #1590) so the token parsers see every `.theme-*` block.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const stylesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src/renderer/styles')

export function readThemeCssSource() {
  const themesDir = path.join(stylesDir, 'themes')
  const files = readdirSync(themesDir).filter((f) => f.endsWith('.css')).sort()
  return [path.join(stylesDir, 'globals.css'), ...files.map((f) => path.join(themesDir, f))]
    .map((p) => readFileSync(p, 'utf-8'))
    .join('\n')
}
