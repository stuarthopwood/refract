// Shared git-status/ignore reader for the File explorer (spec 015 tasks.md T016, research.md
// decisions 2 and 6): answers "what does this working tree look like against HEAD right now"
// (modified/added/untracked/deleted) -- the same question `git status` itself answers, and a
// DIFFERENT question from `diffStat.ts`'s own `diff-index <merge-base>` (committed+uncommitted
// changes since the Session's Base branch, for the details card's +/- counts). A single
// `gitRaw(worktreePath, ['status', '--porcelain=v1', '-z', '--ignored=matching'])` call answers
// BOTH the status-mark question (decision 2) and the ignore-handling question (decision 6):
// `--ignored=matching` makes git's own authoritative ignore engine (nested `.gitignore` files,
// negation patterns, `.git/info/exclude`) list every ignored path alongside the tracked/
// untracked/modified ones in the SAME call, so the "show ignored files" toggle elsewhere just
// stops filtering already-fetched entries rather than triggering a second git process or a
// hand-rolled `.gitignore` parser. `-z` NUL-delimits entries with no C-style path quoting (same
// reasoning `diffStat.ts` already documents for its own `ls-files -z`): non-ASCII/special-
// character filenames and real leading/trailing spaces survive intact. Returns `null` on any
// failure (missing worktree, git failure) so main never throws this into the renderer, matching
// `diffStat.ts`'s own convention exactly.

import { containsGitSegment } from '../ipc/files'
import type { GitStatusMap, GitStatusMark } from '../../shared/model'
import { gitRaw } from './git'

/** Maps one porcelain v1 `XY` status pair to exactly one `GitStatusMark`. `??` is untracked,
 * `!!` is ignored (decision 6's `--ignored=matching` output). A rename (`R` in either position)
 * reports `added`: the map is keyed by the row's own NEW path, which git did not consider
 * "modified" content-wise, so `added` is the closer fit. `D` in either position, when NOT part
 * of a rename, is `deleted`; `A` in either position is `added`; anything else non-blank left is
 * a plain `modified`. */
function markFromCode(code: string): GitStatusMark {
  if (code === '??') return 'untracked'
  if (code === '!!') return 'ignored'
  const isRename = code[0] === 'R' || code[1] === 'R'
  if (isRename) return 'added'
  if (code[0] === 'D' || code[1] === 'D') return 'deleted'
  if (code[0] === 'A' || code[1] === 'A') return 'added'
  return 'modified'
}

/** Parses `-z`-delimited `status --porcelain=v1` output into a `GitStatusMap`. Each entry is
 * `XY<space>path`; a renamed/copied entry additionally carries the renamed-FROM path as its own
 * extra NUL-terminated field right after -- `path` (the new path) is this map's key, and the
 * extra field is consumed and discarded without being treated as an entry of its own. */
function parseStatus(stdout: string): GitStatusMap {
  const map: GitStatusMap = {}
  const tokens = stdout.split('\0')
  let i = 0
  while (i < tokens.length) {
    const entry = tokens[i]
    i++
    if (!entry) continue
    const code = entry.slice(0, 2)
    const filePath = entry.slice(3)
    if (code[0] === 'R' || code[1] === 'R') {
      i++ // renamed-from path: not a map key, the new `filePath` above is
    }
    if (containsGitSegment(filePath)) continue // FR-007: `.git` itself is never a key
    map[filePath] = markFromCode(code)
  }
  return map
}

/** `readGitStatus` (tasks.md T016): the File explorer's shared git-status/ignore reader. One
 * `gitRaw` call (see top-of-file comment) answers both the status-mark and the ignore-handling
 * questions research.md decisions 2 and 6 describe. `gitRaw` itself never rejects, but the
 * surrounding `try`/`catch` is kept anyway so a failure anywhere in this function's own body --
 * not just inside `gitRaw` -- still resolves to `null` rather than throwing into the renderer,
 * matching `diffStat.ts`'s own "never throw" convention exactly. */
export async function readGitStatus(worktreePath: string): Promise<GitStatusMap | null> {
  try {
    const result = await gitRaw(worktreePath, ['status', '--porcelain=v1', '-z', '--ignored=matching'])
    if (result.code !== 0) return null
    return parseStatus(result.stdout)
  } catch {
    return null
  }
}
