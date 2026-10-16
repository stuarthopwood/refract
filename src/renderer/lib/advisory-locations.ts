// Conservative `path:line[:column]` extraction from an advisory's note and guidance (issue
// #558, FR-051 amendment, ui-architect-v3 roundtable decision 4): an ALLOWLISTED code-file
// extension set -- not a bare `\w+` -- is the conservative choice. It naturally excludes
// URL/host false positives like `https://example.com:8080` (`com` is not in the list) without
// any fragile scheme-stripping logic, while still catching `src/foo.ts:42`, `src\foo.ts:42`,
// and `foo.rs:120:5`. A version string (`v1.2.3`) never matches regardless, since it carries no
// `:digit` suffix.
const LOCATION_PATTERN =
  /\b([\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|c|h|cc|cpp|hpp|cs|rb|php|swift|m|mm|sql|sh|ps1|ya?ml|toml|json|md|css|scss|html|vue|svelte)):(\d+)(?::(\d+))?\b/gi

export interface AdvisoryLocation {
  /** The exact matched text (`path:line` or `path:line:column`), shown and copied verbatim. */
  raw: string
  path: string
  line: number
  column?: number
}

/** Scans `text` and `guidance` COMBINED (the issue says "any path:line the note names", with no
 * scoping restriction, and guidance commonly names the fix location too) and returns EVERY
 * match, de-duplicated by its own exact matched text -- never just the first (decisions 4-5). */
export function extractAdvisoryLocations(text: string, guidance?: string): AdvisoryLocation[] {
  const combined = guidance ? `${text}\n${guidance}` : text
  const seen = new Set<string>()
  const locations: AdvisoryLocation[] = []
  for (const match of combined.matchAll(LOCATION_PATTERN)) {
    const raw = match[0]
    if (seen.has(raw)) continue
    seen.add(raw)
    locations.push({
      raw,
      path: match[1]!,
      line: Number(match[2]),
      column: match[3] ? Number(match[3]) : undefined
    })
  }
  return locations
}
