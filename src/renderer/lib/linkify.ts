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

function isPathShaped(candidate: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(candidate)) return true // absolute Windows path, e.g. C:\Repos\...
  return candidate.includes('/') || candidate.includes('\\') // relative, has a path separator
}

/** `null` when `token` (already trimmed by the caller) is not shaped like a file path -- a bare
 * word, a command, a ratio like "4.5:1", or anything else with no path separator and no drive
 * prefix is deliberately left as plain inline code, not guessed at. */
export function parseFileReference(token: string): FileReference | null {
  if (!token) return null
  let candidate = token
  let line: number | undefined
  let col: number | undefined

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
    }
  }

  if (!isPathShaped(candidate)) return null
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
