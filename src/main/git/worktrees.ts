// Worktree lifecycle for a Session (data-model.md `Session.worktreePath`/`branch`, tasks.md T011).
// One Session = one git worktree, created under `<repo>/../pinion-worktrees/<repoName>/<name>`.

import { promises as fs, type Stats } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { git, gitRaw, GitError, normalizeGitPath } from './git'
import { isEnoent } from '../store/atomicJson'

const ADJECTIVES = [
  'amber', 'ancient', 'auburn', 'bold', 'brave', 'bright', 'brisk', 'calm', 'clever', 'cosmic',
  'crisp', 'curious', 'daring', 'earnest', 'eager', 'fleet', 'fluent', 'fond', 'frosty', 'gallant',
  'gentle', 'golden', 'humble', 'keen', 'lively', 'lucid', 'lucky', 'mellow', 'merry', 'mighty',
  'nimble', 'noble', 'placid', 'quiet', 'quick', 'radiant', 'rustic', 'silent', 'sunny', 'swift'
] as const

const NOUNS = [
  'otter', 'falcon', 'badger', 'heron', 'lynx', 'sparrow', 'raven', 'fox', 'wolf', 'hawk',
  'panther', 'orca', 'marten', 'stoat', 'bison', 'gazelle', 'ibex', 'crane', 'egret', 'martin',
  'kestrel', 'osprey', 'puffin', 'tern', 'finch', 'wren', 'lark', 'dove', 'swan', 'stork',
  'plover', 'harrier', 'merlin', 'kite', 'owl', 'vole', 'hare', 'seal', 'walrus', 'beaver'
] as const

/** The directory that holds every worktree for `repo`: `<repo>/../pinion-worktrees/<repoName>`. */
export function worktreesRoot(repo: string): string {
  return path.join(repo, '..', 'pinion-worktrees', path.basename(repo))
}

export async function listBranches(repo: string): Promise<string[]> {
  const stdout = await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  const result = await gitRaw(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
  return result.code === 0
}

/**
 * Reads `origin/HEAD`, falling back to the current branch, then `main`, then `master`, whichever
 * exists (T011).
 */
export async function defaultBranch(repo: string): Promise<string> {
  const symbolic = await gitRaw(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (symbolic.code === 0) {
    const ref = symbolic.stdout.trim()
    const slash = ref.indexOf('/')
    if (ref.length > 0) return slash === -1 ? ref : ref.slice(slash + 1)
  }

  const current = await gitRaw(repo, ['symbolic-ref', '--short', 'HEAD'])
  if (current.code === 0 && current.stdout.trim().length > 0) {
    return current.stdout.trim()
  }

  if (await branchExists(repo, 'main')) return 'main'
  if (await branchExists(repo, 'master')) return 'master'

  throw new GitError('git-failed', `Could not determine a default branch for ${repo}`)
}

/**
 * Picks a readable adjective-noun name (e.g. "swift-otter"), unique against the repository's
 * local branches and the folders already under its worktrees root.
 */
export async function generateName(repo: string): Promise<string> {
  const branches = new Set(await listBranches(repo))

  let existingFolders = new Set<string>()
  try {
    existingFolders = new Set(await fs.readdir(worktreesRoot(repo)))
  } catch (err) {
    if (!isEnoent(err)) throw err
  }

  const attempts = ADJECTIVES.length * NOUNS.length
  for (let i = 0; i < attempts; i++) {
    const candidate = `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]!}-${NOUNS[Math.floor(Math.random() * NOUNS.length)]!}`
    if (!branches.has(candidate) && !existingFolders.has(candidate)) return candidate
  }

  // All 1,600 combinations are taken (practically unreachable): disambiguate with a short suffix.
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]!
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]!
  return `${adjective}-${noun}-${randomBytes(2).toString('hex')}`
}

export interface AddWorktreeResult {
  worktreePath: string
  branch: string
}

/**
 * Creates `<repo>/../pinion-worktrees/<repoName>/<name>` with a new branch `name` off
 * `baseBranch`. On any failure, removes the worktree and branch it created (no half-created
 * Session) and throws a `GitError` mapped to `base-missing`, `path-too-long`, or `worktree-failed`.
 */
export async function addWorktree(repo: string, name: string, baseBranch: string): Promise<AddWorktreeResult> {
  const worktreePath = path.join(worktreesRoot(repo), name)

  try {
    await fs.mkdir(path.dirname(worktreePath), { recursive: true })
  } catch (err) {
    if (isPathTooLongError(err)) throw new GitError('path-too-long', `Worktree path too long: ${worktreePath}`)
    throw err
  }

  const result = await gitRaw(repo, ['worktree', 'add', '-b', name, '--', worktreePath, baseBranch])
  if (result.code !== 0) {
    await cleanupFailedWorktree(repo, name, worktreePath)
    throw mapAddWorktreeError(result.stderr, worktreePath)
  }

  return { worktreePath, branch: name }
}

/**
 * High remediation (corroborated by 3 of 4 reviewers): `addWorktreeFromPullRequestBranch` always
 * used the fixed name `pr-<n>` with no uniqueness check, but reuses `cleanupFailedWorktree`,
 * which is only safe when the caller guarantees a brand-new name the way `addWorktree`'s own
 * `generateName` does. If `pr-<n>` already exists (an earlier session, a failed prior attempt,
 * or an unrelated branch/folder with that name), a second "New session" on the same pull request
 * could `git worktree remove --force` + `branch -D` something THIS attempt never created -- real
 * data loss. Mirrors `generateName`'s own "try the plain name, then `-2`, `-3`, ..." pattern
 * against both local branches and the worktrees-root folder, instead of assuming `pr-<n>` is
 * always free.
 */
export async function uniquePullRequestBranchName(repo: string, number: number): Promise<string> {
  const base = `pr-${number}`
  const branches = new Set(await listBranches(repo))
  let existingFolders = new Set<string>()
  try {
    existingFolders = new Set(await fs.readdir(worktreesRoot(repo)))
  } catch (err) {
    if (!isEnoent(err)) throw err
  }

  if (!branches.has(base) && !existingFolders.has(base)) return base

  const MAX_ATTEMPTS = 1000
  for (let suffix = 2; suffix <= MAX_ATTEMPTS; suffix++) {
    const candidate = `${base}-${suffix}`
    if (!branches.has(candidate) && !existingFolders.has(candidate)) return candidate
  }

  throw new GitError(
    'worktree-failed',
    `Could not find a free local name for pull request #${number}'s worktree: every "${base}"/"${base}-2".."${base}-${MAX_ATTEMPTS}" is already taken.`
  )
}

/**
 * Fetches a pull request's head branch and attaches it to a new worktree
 * (specs/003-pull-request-management research.md decision 6, T024, FR-022):
 * `git fetch origin pull/<number>/head:<localBranchName>` (this ref form works for both
 * same-repository and fork pull requests, confirmed live) then `git worktree add <path>
 * <localBranchName>` -- no `-b`, the branch already exists after the fetch. On any failed step,
 * removes whatever the attempt already created (branch and/or worktree directory), matching
 * `addWorktree`'s own all-or-nothing contract: no half-created Session is ever left behind.
 * `localBranchName` MUST already be collision-checked by the caller (`uniquePullRequestBranchName`
 * above) -- this function's own cleanup-on-failure is only safe for a name this exact attempt
 * created.
 */
export async function addWorktreeFromPullRequestBranch(repo: string, number: number, localBranchName: string): Promise<AddWorktreeResult> {
  const fetchResult = await gitRaw(repo, ['fetch', 'origin', `pull/${number}/head:${localBranchName}`])
  if (fetchResult.code !== 0) {
    // Nothing was created yet (the fetch itself failed): no cleanup needed. The exact "source
    // ref is gone" error is `fatal: couldn't find remote ref <ref>`, git exit code 128
    // (docs/spike/FINDINGS.md row 41, T005).
    throw new GitError('checkout-failed', fetchResult.stderr.trim() || `Could not fetch pull request #${number}'s head branch.`)
  }

  const worktreePath = path.join(worktreesRoot(repo), localBranchName)
  try {
    await fs.mkdir(path.dirname(worktreePath), { recursive: true })
  } catch (err) {
    await gitRaw(repo, ['branch', '-D', '--', localBranchName])
    if (isPathTooLongError(err)) throw new GitError('path-too-long', `Worktree path too long: ${worktreePath}`)
    throw err
  }

  const addResult = await gitRaw(repo, ['worktree', 'add', '--', worktreePath, localBranchName])
  if (addResult.code !== 0) {
    await cleanupFailedWorktree(repo, localBranchName, worktreePath)
    throw mapAddWorktreeError(addResult.stderr, worktreePath)
  }

  return { worktreePath, branch: localBranchName }
}

async function cleanupFailedWorktree(repo: string, name: string, worktreePath: string): Promise<void> {
  await gitRaw(repo, ['worktree', 'remove', '--force', '--', worktreePath])
  try {
    await fs.rm(worktreePath, { recursive: true, force: true })
  } catch {
    // Best effort: leave the directory behind rather than mask the original git failure.
  }
  await gitRaw(repo, ['worktree', 'prune'])
  await gitRaw(repo, ['branch', '-D', '--', name])
}

function mapAddWorktreeError(stderr: string, worktreePath: string): GitError {
  const text = stderr.toLowerCase()
  if (
    text.includes('invalid reference') ||
    text.includes('unknown revision') ||
    text.includes('is not a valid object name') ||
    text.includes('not a valid branch')
  ) {
    return new GitError('base-missing', `Base branch not found: ${stderr.trim()}`)
  }
  if (isPathTooLongError({ message: stderr }) || worktreePath.length >= 260) {
    return new GitError('path-too-long', `Worktree path too long: ${worktreePath}`)
  }
  return new GitError('worktree-failed', stderr.trim() || `git worktree add failed for ${worktreePath}`)
}

function isPathTooLongError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code = 'code' in err ? err.code : undefined
  const message = 'message' in err ? String(err.message) : ''
  return code === 'ENAMETOOLONG' || /file ?name too long/i.test(message)
}

/** Removes the worktree with `git worktree remove --force`, then the branch only when asked. */
export async function removeWorktree(
  repo: string,
  worktreePath: string,
  branch: string,
  opts: { deleteBranch: boolean }
): Promise<void> {
  const result = await gitRaw(repo, ['worktree', 'remove', '--force', '--', worktreePath])
  if (result.code !== 0) {
    throw new GitError('worktree-failed', `git worktree remove failed: ${result.stderr.trim() || result.stdout.trim()}`)
  }
  if (opts.deleteBranch) {
    await git(repo, ['branch', '-D', '--', branch])
  }
}

/** Parses `git worktree list --porcelain` output into each entry's own path (the `worktree `
 * line), trimmed but otherwise raw -- `canonicalPath` below does all normalisation, realpath
 * resolution and case-folding, so both sides of the comparison go through exactly one path. */
function parsePorcelainWorktreePaths(stdout: string): string[] {
  const paths: string[] = []
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      paths.push(line.slice('worktree '.length).trim())
    }
  }
  return paths
}

/** Case-folds only on platforms with a case-insensitive filesystem (quality-gate fix, Low,
 * Sec review): folding unconditionally would let `Repo` and `repo` compare equal as "the same
 * path" on a case-sensitive filesystem (Linux), loosening every containment check below. Used
 * at every comparison point in this file (`canonicalPath`, the root-containment checks, the
 * `gitdir:` admin-area check), so every caller stays in lockstep. */
function comparablePath(p: string): string {
  const normalized = normalizeGitPath(p)
  return process.platform === 'win32' || process.platform === 'darwin' ? normalized.toLowerCase() : normalized
}

/** Resolves `p` to its canonical, comparable form (quality-gate fix, High, all three
 * reviewers): git records each worktree's REALPATH in `git worktree list --porcelain`, not its
 * lexical path, so a repository or worktrees folder reached through a junction, symlink, subst
 * drive, or 8.3 short name must be realpath'd on both sides before comparing -- otherwise a
 * perfectly healthy, registered worktree is misclassified as an orphan and refused with "delete
 * it yourself", regressing exactly the #599 bug this fix closes (reproduced and fixed per the
 * quality gate: `addWorktree` through a junctioned worktrees folder, then Delete). Falls back
 * progressively so an already-gone path still resolves to something comparable: realpath of
 * `p` itself; then realpath of its parent plus the original basename (the long-supported
 * "registered but folder already gone" case, where the parent directory still exists); then a
 * plain lexical resolve. */
async function canonicalPath(p: string): Promise<string> {
  const resolved = path.resolve(p)
  try {
    return comparablePath(await fs.realpath(resolved))
  } catch (err) {
    if (!isEnoent(err)) throw err
  }
  try {
    const realDir = await fs.realpath(path.dirname(resolved))
    return comparablePath(path.join(realDir, path.basename(resolved)))
  } catch (err) {
    if (!isEnoent(err)) throw err
  }
  return comparablePath(resolved)
}

/** Issue #599: decides by what git actually says, never `fs.stat` -- a worktree folder can
 * still exist on disk (an ordinary-looking directory) while git has already lost track of it
 * (a crash mid-removal, a manual `git worktree prune`, hand cleanup), and `git worktree remove`
 * only understands the registered case, exiting 128 "is not a working tree" on the other with
 * no retry path. Compares canonical (realpath'd, platform-folded) paths, never raw strings --
 * see `canonicalPath` above. */
async function isWorktreeRegistered(repo: string, worktreePath: string): Promise<boolean> {
  const stdout = await git(repo, ['worktree', 'list', '--porcelain'])
  const target = await canonicalPath(worktreePath)
  const candidates = await Promise.all(parsePorcelainWorktreePaths(stdout).map(canonicalPath))
  return candidates.includes(target)
}

/** The common `.git` directory for `repo` (resolved to an absolute path): its `worktrees`
 * subdirectory is the ONLY admin area a stray worktree `.git` file is ever allowed to point
 * into (see `removeOrphanedWorktreeFolder` below). `rev-parse --git-common-dir` returns a path
 * relative to `repo` when run from the main checkout, so it is resolved against `repo` rather
 * than assumed absolute. */
async function gitCommonDir(repo: string): Promise<string> {
  const raw = (await git(repo, ['rev-parse', '--git-common-dir'])).trim()
  return normalizeGitPath(path.isAbsolute(raw) ? raw : path.resolve(repo, raw))
}

/** Quality-gate fix (A11y, Low): one reused "is not a worktree and is not empty" message was
 * wrong or unclear for every reason except the literal non-empty-folder case (a file, a link,
 * or a foreign `.git` all got the same "not empty" wording). Every message names what Refract
 * did (nothing) and the next concrete step. */
type OrphanRefusalReason = 'not-empty' | 'not-a-directory' | 'invalid-git-entry' | 'foreign-gitdir'
function orphanRefusalMessage(worktreePath: string, reason: OrphanRefusalReason): string {
  switch (reason) {
    case 'not-empty':
      return `Refract did not delete anything. The worktree folder ${worktreePath} still contains files git no longer tracks. Move or delete them yourself, then choose Delete again.`
    case 'not-a-directory':
      return `Refract did not delete anything. ${worktreePath} is a link or a file, not a worktree folder. Remove it yourself, then choose Delete again.`
    case 'invalid-git-entry':
      return `Refract did not delete anything. ${worktreePath} contains a .git entry Refract does not recognise. Remove it yourself, then choose Delete again.`
    case 'foreign-gitdir':
      return `Refract did not delete anything. ${worktreePath} contains a .git file that belongs to a different repository. Remove it yourself, then choose Delete again.`
  }
}

function isLockLikeError(err: unknown): err is NodeJS.ErrnoException {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false
  const code = (err as NodeJS.ErrnoException).code
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
}

/** Quality-gate fix (A11y, Low): wraps a raw Node fs error (EBUSY/EPERM/EACCES -- a Windows
 * file lock, or a terminal/editor open in the folder) in a plain-language `GitError`; any other
 * error (a genuine bug, an unexpected code) is rethrown unchanged rather than hidden. */
function wrapFsError(err: unknown, worktreePath: string): never {
  if (isLockLikeError(err)) {
    throw new GitError(
      'worktree-failed',
      `Refract could not remove ${worktreePath} because another program is using it. Close any terminal or editor open in that folder, then choose Delete again.`
    )
  }
  throw err
}

/** Quality-gate fix (Sec, Medium): shared by both the registered and orphan removal paths, so
 * a corrupted or hand-edited registry entry naming a path outside this repository's own
 * worktrees can never reach `git worktree remove --force` either -- before this fix only the
 * orphan path checked containment at all. Falls back to a lexical resolve when realpath fails
 * (the "registered but folder already gone" state, where the path cannot be walked on disk);
 * `worktreePath` is always `worktreesRoot(repo)/<name>` under normal operation, so the fallback
 * still correctly contains it. */
async function assertWithinWorktreesRoot(repo: string, worktreePath: string): Promise<void> {
  const resolveOrFallback = (p: string): Promise<string> =>
    fs.realpath(p).then(comparablePath, (err) => {
      if (!isEnoent(err)) throw err
      return comparablePath(path.resolve(p))
    })
  const root = await resolveOrFallback(worktreesRoot(repo))
  const target = await resolveOrFallback(worktreePath)
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new GitError(
      'worktree-failed',
      `Refract did not delete anything. ${worktreePath} is outside Refract's worktree folder (${worktreesRoot(repo)}), so it will not delete it. Check the folder, remove it yourself if it is safe, then choose Delete again.`
    )
  }
}

/** Quality-gate fix (Verif, Medium-a): a folder can be REGISTERED yet already emptied by hand
 * -- its `.git` pointer file deleted (a dotfile, hidden by default in Explorer) while the
 * folder and its git registration both remain. `git worktree remove --force` refuses that
 * state forever ("validation failed ... .git does not exist") on every retry, since nothing
 * else ever deregisters it. True only when the folder exists, is a real directory, and has no
 * `.git` entry at all -- a missing folder is the already-handled "registered, folder gone"
 * case, which `removeWorktree`'s own `--force` already clears. */
async function isRegisteredButHandEmptied(worktreePath: string): Promise<boolean> {
  let stat: Stats
  try {
    stat = await fs.lstat(worktreePath)
  } catch (err) {
    if (isEnoent(err)) return false
    throw err
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return false
  const hasGit = await fs.lstat(path.join(worktreePath, '.git')).then(
    () => true,
    () => false
  )
  return !hasGit
}

/** Issue #599 step 3: removes an UNREGISTERED worktree folder, never a registered one (callers
 * check `isWorktreeRegistered` first; `removeSessionWorktree` below also runs
 * `assertWithinWorktreesRoot` before either branch). Removes the folder only once every one of
 * these holds, refusing (throwing `worktree-failed`, touching nothing) otherwise:
 *
 * - it is a REAL directory: `lstat`, never `stat`, so a symlink or Windows junction/reparse
 *   point pointing at an otherwise-innocent directory is refused, not followed;
 * - its realpath lies STRICTLY inside this repository's `worktreesRoot` (realpath-compared,
 *   platform-folded via `comparablePath` -- stricter than `isStrictDescendantOfOmpSessions` in
 *   `ipc/sessions.ts`, which only `path.resolve`s and always lowercases);
 * - it is then either EMPTY, or holds only a `.git` file -- and that file must be a regular
 *   file (never a symlink), its `gitdir:` line must resolve to STRICTLY inside THIS
 *   repository's own `.git/worktrees` admin area (never the admin area itself, and never
 *   another repository's).
 *
 * Quality-gate fix (Sec, Low, TOCTOU): every filesystem operation below acts on `targetReal`,
 * the realpath just proven to lie inside the root -- never the original, unresolved
 * `worktreePath` -- so an intermediate component swapped for a junction between the containment
 * check and the delete below can never redirect `readdir`/`lstat`/`unlink`/`rmdir` outside the
 * root.
 *
 * No unconditional `git worktree prune` here any more (Code+Sec, Medium): it used to run before
 * every safety check, including on refusal paths, which rewrote `.git/worktrees` for every
 * OTHER Session's stale admin entry too (for example one on a temporarily offline drive) and
 * contradicted "refusal touches nothing". `removeSessionWorktree` now prunes only when it has
 * just proven a need to (this path's own entry was stale, or `branch -D` failed because a stale
 * entry elsewhere still holds the branch).
 *
 * Never a recursive delete of unknown content: the empty-directory case uses a plain `rmdir`
 * (fails if anything is still inside), and the lone-`.git`-file case unlinks that one named
 * file before `rmdir`, rather than `rm -rf` the directory. */
async function removeOrphanedWorktreeFolder(repo: string, worktreePath: string): Promise<void> {
  let stat: Stats
  try {
    stat = await fs.lstat(worktreePath)
  } catch (err) {
    if (isEnoent(err)) return // Not registered, no folder -- nothing to remove.
    wrapFsError(err, worktreePath)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new GitError('worktree-failed', orphanRefusalMessage(worktreePath, 'not-a-directory'))
  }

  const rootReal = await fs.realpath(worktreesRoot(repo)).catch((err) => wrapFsError(err, worktreePath))
  const targetReal = await fs.realpath(worktreePath).catch((err) => wrapFsError(err, worktreePath))
  const root = comparablePath(rootReal)
  const target = comparablePath(targetReal)
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new GitError(
      'worktree-failed',
      `Refract did not delete anything. ${worktreePath} is outside Refract's worktree folder (${worktreesRoot(repo)}), so it will not delete it. Check the folder, remove it yourself if it is safe, then choose Delete again.`
    )
  }

  const entries = await fs.readdir(targetReal).catch((err) => wrapFsError(err, worktreePath))
  if (entries.length === 0) {
    await fs.rmdir(targetReal).catch((err) => wrapFsError(err, worktreePath))
    return
  }
  if (entries.length === 1 && entries[0] === '.git') {
    const gitFilePath = path.join(targetReal, '.git')
    const gitFileStat = await fs.lstat(gitFilePath).catch((err) => wrapFsError(err, worktreePath))
    if (!gitFileStat.isFile()) {
      throw new GitError('worktree-failed', orphanRefusalMessage(worktreePath, 'invalid-git-entry'))
    }
    const content = await fs.readFile(gitFilePath, 'utf8').catch((err) => wrapFsError(err, worktreePath))
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(content)
    if (!match) {
      throw new GitError('worktree-failed', orphanRefusalMessage(worktreePath, 'invalid-git-entry'))
    }
    const gitdirRaw = match[1]!
    const gitdirAbs = path.isAbsolute(gitdirRaw) ? gitdirRaw : path.resolve(targetReal, gitdirRaw)
    // Quality-gate fix (Verif, Low): strict descendant only -- a `gitdir:` pointing at the
    // admin area itself (never a real per-worktree entry) no longer passes.
    const adminRoot = comparablePath(path.join(await gitCommonDir(repo), 'worktrees'))
    const pointsIntoThisRepo = comparablePath(gitdirAbs).startsWith(`${adminRoot}${path.sep}`)
    if (!pointsIntoThisRepo) {
      throw new GitError('worktree-failed', orphanRefusalMessage(worktreePath, 'foreign-gitdir'))
    }
    await fs.unlink(gitFilePath).catch((err) => wrapFsError(err, worktreePath))
    await fs.rmdir(targetReal).catch((err) => wrapFsError(err, worktreePath))
    return
  }
  throw new GitError('worktree-failed', orphanRefusalMessage(worktreePath, 'not-empty'))
}

/**
 * Removes a Session's worktree however it currently stands (issue #599): the single entry point
 * `sessions.delete` should call instead of picking its own path with `fs.stat`.
 *
 * - `assertWithinWorktreesRoot` gates BOTH branches below (Sec, Medium): a corrupted registry
 *   entry can never reach either removal path for a folder outside this repository's worktrees.
 * - Registered, and NOT hand-emptied: identical to `removeWorktree` above (`--force` remove,
 *   which also cleanly handles a registered worktree whose directory has already disappeared,
 *   confirmed against a real repo: prunable, not an error), then the branch.
 * - Registered, but hand-emptied (Verif, Medium-a): its own admin entry is stale even though
 *   git has not yet noticed (`isRegisteredButHandEmptied`); prune clears exactly this entry,
 *   then the orphan-folder checks below take over.
 * - Not registered (and the repository itself could not even be read -- Verif, High-2): a
 *   `GitError` from `isWorktreeRegistered` (repository deleted, moved, or no longer a git repo)
 *   is swallowed only when the worktree folder itself is also confirmed gone (`lstat` ENOENT):
 *   nothing to remove, matching the pre-#599 fallback (`branchExists` already returns `false`
 *   when git fails, so the branch step below is a safe no-op too). Otherwise the folder might
 *   still hold live work, so the original git error is rethrown rather than guessed past.
 * - Not registered, folder present: `removeOrphanedWorktreeFolder` above decides the folder.
 * - The branch is then deleted only if it still exists. A `branch -D` failure is retried once,
 *   after `git worktree prune`, ONLY when git's own message says the branch is in use by a
 *   worktree (verified wording: "cannot delete branch '<b>' used by worktree at '<path>'")
 *   somewhere (Code+Sec, Medium-b): prune only removes entries git itself has already decided
 *   are stale, so a genuinely live worktree elsewhere still correctly blocks the delete, while a
 *   stale one (the same class of bug as #599 itself, just blocking the branch instead of the
 *   folder) no longer wedges the Session forever.
 *
 * Idempotent by construction: whatever step a previous call threw on, the next call re-reads
 * live git/filesystem state from scratch rather than trusting anything cached, so a retry picks
 * up in exactly the state the failed attempt left behind. */
export async function removeSessionWorktree(
  repo: string,
  worktreePath: string,
  branch: string,
  opts: { deleteBranch: boolean }
): Promise<void> {
  await assertWithinWorktreesRoot(repo, worktreePath)

  async function deleteBranchIfRequested(): Promise<void> {
    if (!opts.deleteBranch || !(await branchExists(repo, branch))) return
    try {
      await git(repo, ['branch', '-D', '--', branch])
    } catch (err) {
      if (!(err instanceof GitError) || !/used by worktree|checked out/i.test(err.message)) throw err
      await git(repo, ['worktree', 'prune'])
      await git(repo, ['branch', '-D', '--', branch])
    }
  }

  let registered: boolean
  try {
    registered = await isWorktreeRegistered(repo, worktreePath)
  } catch (gitErr) {
    let worktreeGone: boolean
    try {
      await fs.lstat(worktreePath)
      worktreeGone = false
    } catch (lstatErr) {
      if (!isEnoent(lstatErr)) wrapFsError(lstatErr, worktreePath)
      worktreeGone = true
    }
    if (!worktreeGone) throw gitErr
    await deleteBranchIfRequested()
    return
  }

  if (registered && (await isRegisteredButHandEmptied(worktreePath))) {
    await git(repo, ['worktree', 'prune'])
    registered = false
  }

  if (registered) {
    await removeWorktree(repo, worktreePath, branch, opts)
    return
  }

  await removeOrphanedWorktreeFolder(repo, worktreePath)
  await deleteBranchIfRequested()
}

export interface DeleteCheck {
  uncommittedFiles: number
  unpushedCommits: number
  hasUpstream: boolean
}

/** Feeds the delete confirmation text (contracts/ipc.md `sessions.deleteCheck`). */
export async function deleteCheck(worktreePath: string): Promise<DeleteCheck> {
  const status = await git(worktreePath, ['status', '--porcelain'])
  const uncommittedFiles = status.split('\n').filter((line) => line.trim().length > 0).length

  const upstream = await gitRaw(worktreePath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  const hasUpstream = upstream.code === 0

  const countOutput = await git(worktreePath, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])
  const unpushedCommits = Number.parseInt(countOutput.trim(), 10) || 0

  return { uncommittedFiles, unpushedCommits, hasUpstream }
}

/**
 * Recreates a worktree at its original path, attaching the existing `branch` (no `-b`): used
 * when the worktree folder has disappeared but the branch is intact (tasks.md T043). Callers
 * check `branchExists` first; this only maps the `git worktree add` failure itself. `-f` is
 * required here (not merely permissive): git still has the original worktree registered under
 * `.git/worktrees/<name>/` even though its directory is gone, and a plain `add` refuses with
 * "is a missing but already registered worktree" until `-f`, `prune`, or `remove` clears it.
 */
export async function recreateWorktree(repo: string, worktreePath: string, branch: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(worktreePath), { recursive: true })
  } catch (err) {
    if (isPathTooLongError(err)) throw new GitError('path-too-long', `Worktree path too long: ${worktreePath}`)
    throw err
  }

  const result = await gitRaw(repo, ['worktree', 'add', '-f', '--', worktreePath, branch])
  if (result.code !== 0) {
    if (isPathTooLongError({ message: result.stderr }) || worktreePath.length >= 260) {
      throw new GitError('path-too-long', `Worktree path too long: ${worktreePath}`)
    }
    throw new GitError('worktree-failed', result.stderr.trim() || `git worktree add failed for ${worktreePath}`)
  }
}
