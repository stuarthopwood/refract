// Shared git-status/ignore reader for the File explorer (spec 015 tasks.md T016, research.md
// decisions 2 and 6): answers "what does this working tree look like against HEAD right now"
// (modified/added/untracked/deleted) -- the same question `git status` itself answers, and a
// DIFFERENT question from `diffStat.ts`'s own `diff-index <merge-base>` (committed+uncommitted
// changes since the Session's Base branch, for the details card's +/- counts). A single
// `gitRaw` call (see `readGitStatus`'s own doc comment for the exact invocation) answers BOTH
// the status-mark question (decision 2) and the ignore-handling question (decision 6):
// `--ignored=matching` makes git's own authoritative ignore engine (nested `.gitignore` files,
// negation patterns, `.git/info/exclude`) list every ignored path alongside the tracked/
// untracked/modified ones in the SAME call, so the "show ignored files" toggle elsewhere just
// stops filtering already-fetched entries rather than triggering a second git process or a
// hand-rolled `.gitignore` parser. `-z` NUL-delimits entries with no C-style path quoting (same
// reasoning `diffStat.ts` already documents for its own `ls-files -z`): non-ASCII/special-
// character filenames and real leading/trailing spaces survive intact (PR #671 gate round 4,
// Sec4: confirmed live against a real `sp ace é.txt` fixture, came through intact). Returns
// `null` on any failure (missing worktree, git failure, timeout) so main never throws this into
// the renderer, matching `diffStat.ts`'s own convention exactly.

import { containsGitSegment } from '../fs/paths'
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
 * extra field is consumed and discarded without being treated as an entry of its own.
 *
 * PR #671 gate round 4 fix (High, Sec4/Code4/Verif4, reproduced live): git reports an ignored or
 * untracked DIRECTORY with a trailing `/` (`!! node_modules/`, `?? newdir/`) -- `FileTreeNode.path`
 * never carries one, so the map's own key never matched a tree node's path, and `node_modules`/
 * `dist`-style folders stayed visible with "Show ignored files" off (FR-009), with no mark at all
 * for an untracked folder (FR-010). Fixed by stripping exactly one trailing `/` before using the
 * path as a key -- `withGitStatusMerged` (file-explorer-store.ts) is the other half of this fix,
 * propagating a folder's own mark onto its descendants once expanded, since git's own output
 * marks the folder ONCE, never every file inside it. */
function parseStatus(stdout: string): GitStatusMap {
  const map: GitStatusMap = {}
  const tokens = stdout.split('\0')
  let i = 0
  while (i < tokens.length) {
    const entry = tokens[i]
    i++
    if (!entry) continue
    const code = entry.slice(0, 2)
    const filePath = entry.slice(3).replace(/\/$/, '')
    if (code[0] === 'R' || code[1] === 'R') {
      i++ // renamed-from path: not a map key, the new `filePath` above is
    }
    if (containsGitSegment(filePath)) continue // FR-007: `.git` itself is never a key
    map[filePath] = markFromCode(code)
  }
  return map
}

// PR #671 gate round 4 fix (High/Medium, Sec4/Code4): `--no-optional-locks` plus the matching
// `GIT_OPTIONAL_LOCKS=0` env var (belt and suspenders -- the flag covers this invocation, the env
// var covers any sub-process git itself spawns) stop `status` from taking `.git/index.lock` at
// all, which the gate reproduced live breaking a concurrent agent `git add`/`commit` ("Unable to
// create '.git/index.lock': File exists", 31/60 failures without the fix, 0/30 with it).
// `core.fsmonitor=false`/`core.untrackedCache=false` stop a repo- or worktree-local config value
// from running an external command or trusting a stale cache on every single status read (defence
// in depth: an agent can already run code in this worktree, so this is not a privilege boundary,
// but a malicious/misconfigured repo config should not get an extra, frequent execution hook for
// free). `GIT_TERMINAL_PROMPT=0` stops a credential prompt from hanging the read forever.
//
// Gate round 5 correction (Sec5 Medium): the paragraph above is NOT a claim that this call has
// no repo-config-controlled execution hook at all -- it only covers fsmonitor/untracked-cache.
// Reproduced live: a repo-local `filter.<driver>.clean` (and git-lfs's own clean/smudge filter,
// which is exactly such a driver) still runs on every `status` call regardless of the flags
// above (15 filter invocations across 3 status calls), and a worktree with submodules spawns one
// recursive git child PER submodule. `--ignore-submodules=all` below stops the submodule
// recursion specifically (no FR in this spec distinguishes submodule-internal status marks, so
// skipping them changes no required behaviour); the clean/smudge-filter execution hook itself is
// accepted as a residual -- git's own filter mechanism is inherent to reading status in ANY repo
// that defines one, not something this call's own flags can disable without also breaking the
// status marks that depend on it (e.g. `.gitattributes`-driven text normalisation).
const STATUS_GIT_ARGS = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '--no-optional-locks',
  'status',
  '--porcelain=v1',
  '-z',
  '--ignored=matching',
  '--ignore-submodules=all'
]
const STATUS_GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
// PR #671 gate round 4 fix (Medium, Verif4): a repo with enough untracked/ignored entries to
// exceed Node's own default 1 MiB `maxBuffer` previously returned `null` (no marks, no error,
// indistinguishable from "not a git repo") with no way to tell the two apart. 32 MiB comfortably
// covers even a very large monorepo's own untracked/ignored listing.
const STATUS_MAX_BUFFER_BYTES = 32 * 1024 * 1024
// PR #671 gate round 4 fix (Medium, Code4): contracts/ipc.md already documented "null on ... a
// timeout", which did not exist until now -- a hung `git status` (an interactive credential
// prompt despite `GIT_TERMINAL_PROMPT=0`, a stuck fsmonitor despite the config override above,
// or a pathological repository) would otherwise never resolve at all.
const STATUS_TIMEOUT_MS = 10_000

/** `readGitStatus` (tasks.md T016): the File explorer's shared git-status/ignore reader. One
 * `gitRaw` call (see top-of-file comment) answers both the status-mark and the ignore-handling
 * questions research.md decisions 2 and 6 describe. `gitRaw` itself never rejects, but the
 * surrounding `try`/`catch` is kept anyway so a failure anywhere in this function's own body --
 * not just inside `gitRaw` -- still resolves to `null` rather than throwing into the renderer,
 * matching `diffStat.ts`'s own "never throw" convention exactly. */
export async function readGitStatus(worktreePath: string): Promise<GitStatusMap | null> {
  try {
    const result = await gitRaw(worktreePath, STATUS_GIT_ARGS, {
      env: STATUS_GIT_ENV,
      maxBuffer: STATUS_MAX_BUFFER_BYTES,
      timeoutMs: STATUS_TIMEOUT_MS
    })
    if (result.code !== 0) return null
    return parseStatus(result.stdout)
  } catch {
    return null
  }
}
