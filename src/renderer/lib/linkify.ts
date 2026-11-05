// Matches an inline-code span that is entirely a worktree file reference, optionally `:line[:col]`. Framework-free. (#610)

export interface FileReference {
  /** The bare path, with any trailing `:line[:col]` suffix already removed. */
  path: string
  line?: number
  col?: number
}

// Trailing `:<digits>[:<digits>]` only; a drive letter's colon sits at the start so never matches.
const TRAILING_LINE_COL_RE = /^(.*?):(\d+)(?::(\d+))?$/

// Rejects tokens that merely contain a separator (`origin/main`, `and/or`, `@/lib/x`, globs, shell commands):
// no whitespace, no Windows-forbidden or glob characters, nothing `isLinkableFilePath` refuses (schemes,
// `~`/env-var prefixes, UNC), no `@/` prefix, and, unless a `:line` suffix was stripped, a real extension on
// the last segment.
function isPathShaped(candidate: string, hadLineSuffix: boolean): boolean {
  if (!candidate) return false
  if (/\s/.test(candidate)) return false
  if (/[*?<>|"#]/.test(candidate)) return false
  if (!isLinkableFilePath(candidate)) return false
  // A drive-relative token (`D:foo/x.ts`) is always rejected server-side, so don't render a dead button.
  if (/^[A-Za-z]:(?![\\/])/.test(candidate)) return false
  if (candidate.startsWith('@/')) return false
  const driveAbsolute = /^[A-Za-z]:[\\/]/.test(candidate)
  if (!driveAbsolute && !candidate.includes('/') && !candidate.includes('\\')) return false
  if (hadLineSuffix) return true
  const lastSegment = candidate.split(/[\\/]/).pop() ?? ''
  // Bounded so a MIME subtype like `vnd.api+json` isn't read as an extension.
  return /\.[A-Za-z0-9_-]{1,10}$/.test(lastSegment)
}

/** `null` when `token` (already trimmed) isn't path-shaped; such tokens stay plain inline code. */
export function parseFileReference(token: string): FileReference | null {
  if (!token) return null
  let candidate = token
  let line: number | undefined
  let col: number | undefined
  let hadLineSuffix = false

  const match = TRAILING_LINE_COL_RE.exec(token)
  if (match) {
    const [, base, lineStr, colStr] = match
    // Keeps a lone drive letter from being read as a path once its colon is stripped as a line suffix.
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

// `scheme://` needs two or more scheme letters so a drive letter (`C:/`) is never mistaken for one.
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]+:\/\//
// `$VAR` / `%VAR%` prefixes: the shell would expand them, the worktree resolver never does.
const ENV_VAR_PREFIX_RE = /^(?:\$|%[^%\\/]+%)/

/** `false` for a target that is not a worktree file path (`xd://`, `file://`, `~`, `$VAR`, `%VAR%`, UNC, empty), so it must never be drawn as a file link. */
export function isLinkableFilePath(filePath: string): boolean {
  if (!filePath) return false
  if (URL_SCHEME_RE.test(filePath)) return false
  if (filePath.startsWith('~') || ENV_VAR_PREFIX_RE.test(filePath)) return false
  // Normalise first so a backslash-form UNC path (`\\host\share`) is caught too.
  return !filePath.replace(/\\/g, '/').startsWith('//')
}

/** String-only early-out for an absolute path obviously outside the worktree; relative paths pass. Not the security boundary (`resolveInWorktree` is). */
export function looksWithinWorktree(filePath: string, worktreePath: string): boolean {
  if (!/^[A-Za-z]:[\\/]/.test(filePath) && !filePath.startsWith('/')) return true // relative
  // ASCII-only case fold: Unicode `toLowerCase()` maps the Kelvin sign to 'k', which NTFS treats as distinct.
  const normalize = (value: string) =>
    value
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .replace(/[A-Z]/g, (c) => c.toLowerCase())
  const normalizedPath = normalize(filePath)
  const normalizedRoot = normalize(worktreePath)
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)
}
