// Conservative `path:line[:column]` extraction from an advisory's note and guidance (issue
// #558, FR-051 amendment, ui-architect-v3 roundtable decision 4; regex corrected gate round 1).
//
// An ALLOWLISTED code-file extension set -- not a bare `\w+` -- is the conservative choice: it
// naturally excludes URL/host false positives without any fragile scheme-stripping logic. The
// leading `(?<![\w./\\:-])` lookbehind (replacing a plain `\b`, gate round 1 fix: `\b` chopped
// path prefixes -- `C:\Repos\x\foo.ts:42` became `Repos\x\foo.ts:42`, `/home/x/foo.ts:1` lost
// its leading `/`) only allows a match to START where the preceding character is NOT itself
// part of a path/URL -- this also rejects a URL's own host segment as an emergent property,
// with no separate `://` check needed: every segment boundary inside `https://host/a/b.ts:1` is
// itself preceded by `/` or `:`, both excluded, so no valid start position exists anywhere in a
// scheme-qualified URL. The optional prefix group restores a drive letter (`C:\`), a relative
// prefix (`./`, `../`), or a bare absolute-path leading `/` that the body's own character class
// (which excludes `:` to keep the line-number delimiter unambiguous) cannot include itself. The
// body is bounded to `{1,260}` characters (gate round 1 Security Low: an unbounded `+` lets the
// class restart at every `/`/`.`/`-` boundary in a long, hostile note, costing roughly quadratic
// time against the ~40 extension alternatives).
const LOCATION_PATTERN =
  /(?<![\w./\\:-])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|\/)?[\w./\\-]{1,260}\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|c|h|cc|cpp|hpp|cs|rb|php|swift|m|mm|sql|sh|ps1|ya?ml|toml|json|md|css|scss|html|vue|svelte)):(\d+)(?::(\d+))?\b/gi

export interface AdvisoryLocation {
  /** The exact matched text (`path:line` or `path:line:column`), shown and copied verbatim. */
  raw: string
  path: string
  line: number
  column?: number
}

/** Scans `text` and `guidance` COMBINED (the issue says "any path:line the note names", with no
 * scoping restriction, and guidance commonly names the fix location too) and returns EVERY
 * match, de-duplicated by its own `path:line` pair (gate round 1 fix: de-duplicating by the raw
 * matched text let `foo.ts:42` and `foo.ts:42:5` both render as if they were different
 * locations) -- the FIRST raw text for a given pair wins, never just the first match overall. */
export function extractAdvisoryLocations(text: string, guidance?: string): AdvisoryLocation[] {
  const combined = guidance ? `${text}\n${guidance}` : text
  const seen = new Set<string>()
  const locations: AdvisoryLocation[] = []
  for (const match of combined.matchAll(LOCATION_PATTERN)) {
    const path = match[1]!
    const line = Number(match[2])
    const key = `${path}:${line}`
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
