// Conservative `path:line[:column]` extraction from an advisory's note and guidance. (#558)
// The extension allowlist excludes URL false positives; the lookbehind stops a match starting inside a
// path/URL; the body is bounded to {1,260} against quadratic backtracking. `@~+` are in both so scoped
// paths aren't truncated. Accepted limits: a path with a literal space extracts only its tail, and
// `Location:src/a.ts:1` never matches.
const LOCATION_PATTERN =
  /(?<![\w./\\:@~+-])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|\/)?[\w./\\@~+-]{1,260}\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|c|h|cc|cpp|hpp|cs|rb|php|swift|m|mm|sql|sh|ps1|ya?ml|toml|json|md|css|scss|html|vue|svelte)):(\d+)(?::(\d+))?\b/gi

export interface AdvisoryLocation {
  /** The exact matched text (`path:line` or `path:line:column`), shown and copied verbatim. */
  raw: string
  path: string
  line: number
  column?: number
}

/** Extracts every `path:line` from `text` and `guidance` combined, de-duplicated by normalised path and line (first raw text wins); `raw` is never normalised. */
export function extractAdvisoryLocations(text: string, guidance?: string): AdvisoryLocation[] {
  const combined = guidance ? `${text}\n${guidance}` : text
  const seen = new Set<string>()
  const locations: AdvisoryLocation[] = []
  for (const match of combined.matchAll(LOCATION_PATTERN)) {
    const path = match[1]!
    const line = Number(match[2])
    const key = `${path.replace(/\\/g, '/')}:${line}`
    if (seen.has(key)) continue
    seen.add(key)
    locations.push({
      raw: match[0],
      path,
      line,
      column: match[3] ? Number(match[3]) : undefined
    })
  }
  return locations
}
