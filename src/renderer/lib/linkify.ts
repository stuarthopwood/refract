// Issue #610: a pure matcher for the one file-link detection rule this story's v1 scope covers --
// an inline-code span whose ENTIRE text is a worktree file reference, optionally suffixed with
// `:line[:col]`. No prose scanning, no other link kinds (web URLs are handled separately, by
// `safeUrl`/remark-gfm's own autolinking -- see `Markdown.tsx`). Kept framework-free (no React) so
// it can be exercised in isolation.

export interface FileReference {
  /** The bare path, with any trailing `:line[:col]` suffix already removed. */
  path: string
  line?: number
  col?: number
}

// Matches a trailing `:<digits>` or `:<digits>:<digits>` at the END of the string only -- never
// a drive letter's own colon (`C:\...`), which this never reaches as a *trailing* match since a
// drive letter sits at the very start, not the end, of a real path.
const TRAILING_LINE_COL_RE = /^(.*?):(\d+)(?::(\d+))?$/

// Quality-gate fix (Code/Verif HIGH/Medium, round 2): the original rule -- any path separator
// anywhere -- linkified `origin/main`, `owner/repo`, `feat/610-hyperlinks`, `text/html`, `and/or`,
// `@/lib/linkify`, `**/*.ts`, and whole shell commands (`git diff origin/main`), each becoming a
// dead "Show in File Explorer" button. A candidate must now ALSO: contain no whitespace (a real
// single-token path never does); contain none of the characters Windows forbids in a path or that
// signal something else entirely (`*?<>|"#`); not contain `://` (scheme-shaped -- `safeUrl` already
// had first refusal, this is never a second path guess at the same text); not start with `//`
// (UNC-shaped) or `@/` (this repo's own import-alias convention, not a filesystem path); and
// finally -- unless a trailing `:line[:col]` suffix was itself already stripped, which is strong
// standalone evidence this is a source reference -- have a real extension on its last segment, the
// one signal that actually tells `origin/main` (no extension) apart from `src/App.tsx` (does).
function isPathShaped(candidate: string, hadLineSuffix: boolean): boolean {
  if (!candidate) return false
  if (/\s/.test(candidate)) return false
  if (/[*?<>|"#]/.test(candidate)) return false
  if (candidate.includes('://')) return false
  // Quality-gate fix (round 3): normalise backslashes to forward slashes BEFORE the UNC check --
  // `startsWith('//')` on the raw candidate missed a backslash-form UNC path (`\\host\share\x.ts`),
  // which does not literally start with `//` even though it is exactly as UNC-shaped as
  // `//host/share/x.ts`. Mirrors the same backslash-first normalisation `files.ts`'s own UNC
  // check already uses.
  if (candidate.replace(/\\/g, '/').startsWith('//')) return false
  if (candidate.startsWith('@/')) return false
  const driveAbsolute = /^[A-Za-z]:[\\/]/.test(candidate)
  if (!driveAbsolute && !candidate.includes('/') && !candidate.includes('\\')) return false
  if (hadLineSuffix) return true
  const lastSegment = candidate.split(/[\\/]/).pop() ?? ''
  // Quality-gate fix (Code2 Low, round 3): bounded to `[A-Za-z0-9_-]{1,10}` (was `[^\\/.]+`,
  // unbounded and allowing any character including `+`) -- the old pattern matched a MIME type's
  // own subtype tail (`application/vnd.api+json` -> "extension" `api+json`) as if it were a real
  // file extension. A real extension on this codebase's own file types (`.ts`, `.tsx`, `.json`,
  // `.yml`, `.gitignore` minus the leading dot, etc.) always fits this bound.
  return /\.[A-Za-z0-9_-]{1,10}$/.test(lastSegment)
}

/** `null` when `token` (already trimmed by the caller) is not shaped like a file path -- a bare
 * word, a command, a ratio like "4.5:1", a package/mime name, or anything else `isPathShaped`
 * rejects is deliberately left as plain inline code, not guessed at. */
export function parseFileReference(token: string): FileReference | null {
  if (!token) return null
  let candidate = token
  let line: number | undefined
  let col: number | undefined
  let hadLineSuffix = false

  const match = TRAILING_LINE_COL_RE.exec(token)
  if (match) {
    const [, base, lineStr, colStr] = match
    // Guards against a drive letter alone (`C`) ever being mistaken for a path once its own
    // colon is stripped as a line suffix; `isPathShaped` below would reject a bare `C` anyway
    // (no separator), so this is defence in depth, not the only thing preventing it.
    if (base && base.length > 0 && !/^[A-Za-z]$/.test(base)) {
      candidate = base
      line = Number(lineStr)
      col = colStr ? Number(colStr) : undefined
      hadLineSuffix = true
    }
  }

  if (!isPathShaped(candidate, hadLineSuffix)) return null
  return { path: candidate, line, col }
}

/** Cheap, string-only early-out for an absolute path that is obviously outside the Session's own
 * worktree (decision #610: "no existence check at render time; that would flood IPC"). A
 * relative path is always allowed through as a candidate -- it is presumed worktree-relative,
 * and the real, authoritative check happens server-side in `resolveInWorktree` on click. Never
 * the security boundary itself, only a visual nicety that avoids linkifying an obviously-foreign
 * absolute path as if it might work. */
export function looksWithinWorktree(filePath: string, worktreePath: string): boolean {
  if (!/^[A-Za-z]:[\\/]/.test(filePath) && !filePath.startsWith('/')) return true // relative
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const normalizedPath = normalize(filePath)
  const normalizedRoot = normalize(worktreePath)
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)
}
