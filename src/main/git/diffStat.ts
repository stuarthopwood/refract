// Read-only diff stat for the session details card (tasks.md T068, contracts/ipc.md
// `sessions.diffStat`): committed and uncommitted edits to tracked files since the merge-base
// with the Session's Base branch, plus new untracked files. Never writes: no `git add`, no index
// change. Returns `null` on any failure (missing worktree, missing Base branch, git failure, or
// the overall timeout) so main never throws this into the renderer.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DiffStat } from '../../shared/ipc'
import { gitRaw } from './git'

const MAX_FILES = 200
const MAX_FILE_BYTES = 1024 * 1024
const TIMEOUT_MS = 3000
/** Only the first slice of a file is checked for a NUL byte (git's own binary heuristic). */
const BINARY_SNIFF_BYTES = 8000

function isBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, BINARY_SNIFF_BYTES)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

/** Counts lines the way a brand-new file's `git diff --numstat` would: a trailing newline does
 * not add an extra empty line, but trailing content without one still counts as a line. */
function countLines(text: string): number {
  if (text === '') return 0
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
  if (trimmed === '') return 0
  return trimmed.split('\n').length
}

async function computeDiffStat(worktreePath: string, baseBranch: string, signal: AbortSignal): Promise<DiffStat | null> {
  const mergeBaseResult = await gitRaw(
    worktreePath,
    ['merge-base', '--end-of-options', 'HEAD', baseBranch],
    { signal }
  )
  if (mergeBaseResult.code !== 0) return null
  const mergeBase = mergeBaseResult.stdout.trim()
  if (!mergeBase) return null

  // Plumbing, not porcelain `git diff`: `diff-index` never refreshes or writes the index, so a
  // concurrent `git add`/`git commit` in the same worktree cannot race it on `index.lock`.
  // `--no-ext-diff --no-textconv` stop a diff driver from git config running arbitrary commands.
  const numstatResult = await gitRaw(
    worktreePath,
    ['diff-index', '--no-ext-diff', '--no-textconv', '--numstat', mergeBase],
    { signal }
  )
  if (numstatResult.code !== 0) return null

  // `-z` NUL-delimits entries with no C-style quoting, so non-ASCII/special-character paths
  // (e.g. `café.txt`, which git would otherwise print as a quoted `"caf\303\251.txt"`) and
  // paths with real leading/trailing spaces survive intact; `.trim()` would corrupt the latter.
  const untrackedResult = await gitRaw(
    worktreePath,
    ['ls-files', '-z', '--others', '--exclude-standard'],
    { signal }
  )
  if (untrackedResult.code !== 0) return null

  let files = 0
  let additions = 0
  let deletions = 0
  let partial = false

  for (const line of numstatResult.stdout.split('\n')) {
    if (line.trim() === '') continue
    if (files >= MAX_FILES) {
      partial = true
      break
    }
    const [addRaw, delRaw] = line.split('\t')
    files += 1
    if (addRaw !== '-') additions += Number.parseInt(addRaw ?? '0', 10) || 0
    if (delRaw !== '-') deletions += Number.parseInt(delRaw ?? '0', 10) || 0
  }

  if (!partial) {
    const untrackedPaths = untrackedResult.stdout.split('\0').filter((entry) => entry.length > 0)

    for (const relativePath of untrackedPaths) {
      if (signal.aborted) return null
      if (files >= MAX_FILES) {
        partial = true
        break
      }
      files += 1
      const absolutePath = path.join(worktreePath, relativePath)
      let stat: { size: number }
      try {
        stat = await fs.stat(absolutePath)
      } catch {
        continue // vanished between ls-files and stat; already counted, 0 additions
      }
      if (stat.size > MAX_FILE_BYTES) {
        partial = true
        continue
      }
      let buf: Buffer
      try {
        buf = await fs.readFile(absolutePath)
      } catch {
        continue
      }
      if (isBinary(buf)) continue // binary files count as a file with 0 lines
      additions += countLines(buf.toString('utf8'))
    }
  }

  return { files, additions, deletions, partial }
}

/** `sessions.diffStat(id)` (contracts/ipc.md): `worktreePath`/`baseBranch` come from the
 * registry, never the renderer (constitution V). `null` when the worktree is missing, the Base
 * branch no longer exists, git fails, or the 3 s overall budget runs out before completion; the
 * in-flight git process is aborted in that last case, never left running. */
export async function diffStat(worktreePath: string, baseBranch: string): Promise<DiffStat | null> {
  try {
    await fs.access(worktreePath)
  } catch {
    return null
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await computeDiffStat(worktreePath, baseBranch, controller.signal)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
