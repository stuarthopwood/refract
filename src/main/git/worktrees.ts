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

/** Case-folds only on platforms with a case-insensitive filesystem: folding unconditionally
 * would let `Repo` and `repo` compare equal as "the same path" on a case-sensitive filesystem
 * (Linux), loosening every containment check below. Used at every comparison point in this
 * file, so every caller stays in lockstep. */
function comparablePath(p: string): string {
  const normalized = normalizeGitPath(p)
  return process.platform === 'win32' || process.platform === 'darwin' ? normalized.toLowerCase() : normalized
}

/** Resolves `p` to its canonical, comparable form: git records each worktree's REALPATH in
 * `git worktree list --porcelain`, not its lexical path, so a repository or worktrees folder
 * reached through a junction, symlink, subst drive, or 8.3 short name must be realpath'd on
 * both sides before comparing. Walks UP to the nearest existing ancestor directory (realpathing
 * that), then rejoins the remaining path segments unresolved, rather than trying only one level
 * -- so a worktree gone under a worktrees-root that is ALSO gone (both missing) still
 * canonicalises consistently against its sibling root computed the same way. Only once the
 * filesystem root itself is reached without finding anything real does it fall back to a plain
 * lexical resolve. */
async function canonicalPath(p: string): Promise<string> {
  const resolved = path.resolve(p)
  const trailing: string[] = []
  let dir = resolved
  for (;;) {
    try {
      const real = await fs.realpath(dir)
      return comparablePath(trailing.length === 0 ? real : path.join(real, ...trailing))
    } catch (err) {
      if (!isEnoent(err)) throw err
    }
    const parent = path.dirname(dir)
    if (parent === dir) return comparablePath(resolved) // Filesystem root reached; give up realpathing.
    trailing.unshift(path.basename(dir))
    dir = parent
  }
}

/** Issue #599: decides by what git actually says, never `fs.stat` -- a worktree folder can
 * still exist on disk while git has already lost track of it, and `git worktree remove` only
 * understands the registered case, exiting 128 "is not a working tree" on the other with no
 * retry path. Compares canonical (realpath'd, platform-folded) paths, never raw strings. One
 * OTHER registered candidate whose path cannot be canonicalised (EACCES/EPERM/ENOTDIR on some
 * unrelated Session's worktree) is dropped rather than letting its error block deleting THIS,
 * unrelated, Session; the target itself is still canonicalised strictly, wrapped in
 * `wrapFsError` so a failure there is at least plain-language. */
async function isWorktreeRegistered(repo: string, worktreePath: string): Promise<boolean> {
  const stdout = await git(repo, ['worktree', 'list', '--porcelain'])
  const target = await canonicalPath(worktreePath).catch((err) => wrapFsError(err, worktreePath))
  const candidates = await Promise.all(parsePorcelainWorktreePaths(stdout).map((p) => canonicalPath(p).catch(() => null)))
  return candidates.includes(target)
}

/** Verifies `repo` IS its own git toplevel, never an ancestor repository, and that git's
 * self-reported identity ties back to `repo` itself -- not merely to each other (a redirected
 * `GIT_DIR` can make `--show-toplevel`, `--absolute-git-dir` and `--git-common-dir` all agree
 * with ONE ANOTHER while still naming a wholly different repository). git searches UPWARD
 * through parent directories for a `.git`, so without this a corrupted or
 * redirected repository would let every git command below silently operate on the wrong one,
 * including `branch -D` force-deleting a same-named branch there. Read-only throughout: even
 * if any answer DOES resolve to the wrong repository, nothing is mutated by asking.
 *
 * `gitRaw` (`git.ts`) strips `GIT_DIR`-class override variables from its own environment,
 * case-insensitively, for every invocation -- the primary defence. This is independent,
 * defence-in-depth verification on top of that: for the ordinary main-checkout case
 * (`--absolute-git-dir` equals `--git-common-dir`), that common dir must literally BE
 * `<repo>/.git`; for the linked-worktree-as-repo case, `<repo>/.git` must be a regular file
 * whose own `gitdir:` line canonicalises to exactly what git reported -- so an override
 * pointing at some OTHER repository's linked-worktree admin area, which could satisfy the
 * weaker "do git's own answers agree with each other" check alone, still fails here. */
async function isRepoReadable(repo: string): Promise<boolean> {
  const toplevelResult = await gitRaw(repo, ['rev-parse', '--show-toplevel'])
  if (toplevelResult.code !== 0) return false
  const toplevel = toplevelResult.stdout.trim()
  if (toplevel.length === 0) return false
  if ((await canonicalPath(toplevel)) !== (await canonicalPath(repo))) return false

  const gitDirResult = await gitRaw(repo, ['rev-parse', '--absolute-git-dir'])
  if (gitDirResult.code !== 0) return false
  const gitDirRaw = gitDirResult.stdout.trim()
  if (gitDirRaw.length === 0) return false
  const commonDirResult = await gitRaw(repo, ['rev-parse', '--git-common-dir'])
  if (commonDirResult.code !== 0) return false
  const commonDirRaw = commonDirResult.stdout.trim()
  if (commonDirRaw.length === 0) return false
  const commonDirAbs = path.isAbsolute(commonDirRaw) ? commonDirRaw : path.resolve(repo, commonDirRaw)
  const gitDir = await canonicalPath(gitDirRaw)
  const commonDir = await canonicalPath(commonDirAbs)

  if (gitDir === commonDir) {
    const expectedDotGit = await canonicalPath(path.join(repo, '.git'))
    return commonDir === expectedDotGit
  }

  const worktreesAdminRoot = await canonicalPath(path.join(commonDirAbs, 'worktrees'))
  if (!gitDir.startsWith(`${worktreesAdminRoot}${path.sep}`)) return false
  const dotGitPath = path.join(repo, '.git')
  const dotGitStat = await fs.lstat(dotGitPath).catch(() => null)
  if (!dotGitStat || !dotGitStat.isFile()) return false
  const dotGitContent = await fs.readFile(dotGitPath, 'utf8').catch(() => null)
  if (dotGitContent === null) return false
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(dotGitContent)
  if (!match) return false
  const recordedRaw = match[1]!
  const recordedAbs = path.isAbsolute(recordedRaw) ? recordedRaw : path.resolve(repo, recordedRaw)
  return (await canonicalPath(recordedAbs)) === gitDir
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

/** One reused "is not a worktree and is not empty" message was wrong, unclear, or (for a link)
 * actively unsafe advice for every reason except the literal non-empty-folder case. `is-a-link`
 * is split from the plain-file case: "remove it yourself" for a junction/symlink could be read
 * as "delete its target". `registered-not-empty` is split from the plain orphan `not-empty`: a
 * folder git STILL has registered needs different wording (restoring its `.git` file is also a
 * valid way out, not just deleting the leftover files). Every message names what Refract did
 * (nothing) and the next concrete step that actually works. */
type OrphanRefusalReason = 'not-empty' | 'registered-not-empty' | 'is-a-link' | 'not-a-directory' | 'invalid-git-entry' | 'foreign-gitdir'
function orphanRefusalMessage(worktreePath: string, reason: OrphanRefusalReason): string {
  switch (reason) {
    case 'not-empty':
      return `Refract did not delete anything. The worktree folder ${worktreePath} still contains files or folders git no longer tracks. Move anything you want to keep somewhere else, then delete the folder itself (Refract only ever removes an empty folder), then choose Delete again.`
    case 'registered-not-empty':
      return `Refract did not delete anything. The worktree folder ${worktreePath} is still registered with git, but its own .git file is gone and real files remain. Move or delete them yourself, or restore its .git file, then choose Delete again.`
    case 'is-a-link':
      return `Refract did not delete anything. ${worktreePath} is a link, not a worktree folder. Remove only the link itself (in File Explorer delete the link; do not delete its contents), then choose Delete again.`
    case 'not-a-directory':
      return `Refract did not delete anything. ${worktreePath} is a file, not a worktree folder. Remove it yourself, then choose Delete again.`
    case 'invalid-git-entry':
      return `Refract did not delete anything. ${worktreePath} contains a .git folder or file Refract does not recognise; it may be a separate repository. Check what it is, and if you no longer need it, move the folder somewhere else yourself, then choose Delete again.`
    case 'foreign-gitdir':
      return `Refract did not delete anything. ${worktreePath} contains a .git file that does not point to one of this repository's worktrees. Check it, and if you no longer need it, delete that .git file (or move the folder) yourself, then choose Delete again.`
  }
}

/** Names the admin folder (with a next step) rather than a single worktree when `target` is
 * itself `worktreesRoot(repo)`, and never invites the user to delete a path that might BE a
 * repository they still need. Reached only for a real (non-link, already excluded by the
 * caller), EXISTING directory outside the root -- `assertWithinWorktreesRoot` never reaches
 * this for a path that no longer exists, since there is nothing there to protect or to retry
 * deleting, and this same text would otherwise be a dead end the user can never act on. */
function outsideWorktreesRootMessage(worktreePath: string, root: string, isRootItself: boolean): string {
  if (isRootItself) {
    return `Refract did not delete anything. ${worktreePath} is Refract's worktree folder itself, not a single worktree. Delete the individual Session worktrees inside it instead, then choose Delete again for each.`
  }
  return `Refract did not delete anything. ${worktreePath} is outside Refract's worktree folder (${root}), so Refract will never remove it. To remove this Session, move or rename that folder yourself (only if you are sure it is not your own work), then choose Delete again.`
}

function lockedWorktreeMessage(worktreePath: string): string {
  return `Refract did not delete anything. Git has locked the worktree ${worktreePath}, so Refract will not remove it. If you no longer need it, unlock it first: run \`git worktree unlock\` in the repository, followed by that folder's path, then choose Delete again.`
}

function isLockLikeError(err: unknown): err is NodeJS.ErrnoException {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false
  const code = (err as NodeJS.ErrnoException).code
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
}

/** Wraps a raw Node fs error in a plain-language `GitError`; any other error (a genuine bug, an
 * unexpected code) is rethrown unchanged rather than hidden. EBUSY (a program has the folder
 * open) gets its own wording; EPERM/EACCES (a real Windows permission problem as often as a
 * lock) gets a distinct one that does not assert a cause the code cannot actually confirm. */
function wrapFsError(err: unknown, worktreePath: string): never {
  if (isLockLikeError(err)) {
    if (err.code === 'EBUSY') {
      throw new GitError(
        'worktree-failed',
        `Refract could not remove ${worktreePath} because another program is using it. Close any terminal or editor open in that folder, then choose Delete again.`
      )
    }
    throw new GitError(
      'worktree-failed',
      `Refract could not remove ${worktreePath}: Windows denied access. Another program may be using it, or you may not have permission. Close any terminal or editor open in that folder, check its permissions, then choose Delete again.`
    )
  }
  throw err
}

type RootContainment = 'inside' | 'outside-missing'

/** Shared by both the registered and orphan removal paths, so a corrupted or hand-edited
 * registry entry naming a path outside this repository's own worktrees can never reach either
 * removal path. Uses `canonicalPath` for BOTH sides, so a gone worktree under a (possibly also
 * gone, possibly aliased) root still canonicalises exactly like its sibling root.
 *
 * Returns `'outside-missing'`, rather than silently permitting the call to continue, when the
 * path is outside the root AND does not exist: `removeSessionWorktree` must treat that
 * specially, never calling `git worktree remove --force` on a path outside the root that git
 * still has registered -- for example a worktree on a disconnected drive -- which would
 * otherwise delete that OTHER worktree's entire admin entry, HEAD, index and any unpushed
 * commits on its branch. A path outside the root that EXISTS is refused outright, same as
 * before. */
async function assertWithinWorktreesRoot(repo: string, worktreePath: string): Promise<RootContainment> {
  const root = await canonicalPath(worktreesRoot(repo)).catch((err) => wrapFsError(err, worktreePath))
  const target = await canonicalPath(worktreePath).catch((err) => wrapFsError(err, worktreePath))
  if (target === root) {
    throw new GitError('worktree-failed', outsideWorktreesRootMessage(worktreePath, worktreesRoot(repo), true))
  }
  if (target.startsWith(`${root}${path.sep}`)) return 'inside'

  let exists: boolean
  try {
    await fs.lstat(worktreePath)
    exists = true
  } catch (err) {
    if (!isEnoent(err)) wrapFsError(err, worktreePath)
    exists = false
  }
  if (!exists) return 'outside-missing'
  throw new GitError('worktree-failed', outsideWorktreesRootMessage(worktreePath, worktreesRoot(repo), false))
}

/** A folder can be REGISTERED yet already emptied by hand -- its `.git` pointer file deleted (a
 * dotfile, hidden by default in Explorer) while the folder and its git registration both
 * remain. `git worktree remove --force` refuses that state forever ("validation failed ... .git
 * does not exist") on every retry, since nothing else ever deregisters it. True only when the
 * folder exists, is a real directory, and has no `.git` entry at all -- a missing folder is the
 * already-handled "registered, folder gone" case, which `--force` already clears on its own. */
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

function adminEntryRefusalMessage(worktreePath: string): string {
  return `Refract did not delete anything. It could not safely identify ${worktreePath}'s own git admin entry. Remove that folder yourself, then choose Delete again.`
}

/** Replaces an unconditional, repo-wide `git worktree prune` this used to run for a
 * hand-emptied registered folder: `prune` drops every OTHER stale admin entry in the repo too
 * (for example a Session on a temporarily disconnected drive), deleting its index, HEAD and any
 * in-progress rebase or merge state -- even on a call that ultimately refuses. Finds and removes
 * ONLY the one admin directory under `<gitCommonDir>/worktrees/` whose `gitdir` file
 * canonicalises to `<worktreePath>/.git`: a bounded, verified removal of known git-internal
 * bookkeeping files (HEAD/index/commondir/gitdir), never user content. Refuses (removes
 * nothing) if the entry is locked, or if zero or more than one candidate matches -- never
 * guesses. A relative `gitdir` record (git's `worktree.useRelativePaths`) is resolved against
 * the ADMIN entry's own directory, never `process.cwd()`. */
async function removeAdminEntryFor(repo: string, worktreePath: string): Promise<void> {
  const adminRoot = path.join(await gitCommonDir(repo), 'worktrees')
  const wantedGitFile = await canonicalPath(path.join(worktreePath, '.git'))
  let entries: string[]
  try {
    entries = await fs.readdir(adminRoot)
  } catch (err) {
    if (isEnoent(err)) return // No admin area at all: nothing to clear.
    wrapFsError(err, worktreePath)
  }
  const matches: string[] = []
  for (const entry of entries) {
    const entryDir = path.join(adminRoot, entry)
    const recorded = await fs.readFile(path.join(entryDir, 'gitdir'), 'utf8').then(
      (c) => c.trim(),
      () => null
    )
    if (recorded === null) continue
    const recordedAbs = path.isAbsolute(recorded) ? recorded : path.resolve(entryDir, recorded)
    const recordedCanonical = await canonicalPath(recordedAbs).catch(() => null)
    if (recordedCanonical === wantedGitFile) matches.push(entryDir)
  }
  if (matches.length !== 1) {
    throw new GitError('worktree-failed', adminEntryRefusalMessage(worktreePath))
  }
  const [adminEntry] = matches as [string]
  const locked = await fs.lstat(path.join(adminEntry, 'locked')).then(
    () => true,
    () => false
  )
  if (locked) {
    throw new GitError('worktree-failed', lockedWorktreeMessage(worktreePath))
  }
  const adminRootCanonical = await canonicalPath(adminRoot)
  const entryCanonical = await canonicalPath(adminEntry)
  if (entryCanonical === adminRootCanonical || !entryCanonical.startsWith(`${adminRootCanonical}${path.sep}`)) {
    throw new GitError('worktree-failed', adminEntryRefusalMessage(worktreePath))
  }
  await fs.rm(adminEntry, { recursive: true }).catch((err) => wrapFsError(err, worktreePath))
}

/** Issue #599 step 3: removes an UNREGISTERED worktree folder, never a registered one (callers
 * check `isWorktreeRegistered` first; `removeSessionWorktree` below also runs a link check and
 * `assertWithinWorktreesRoot` before either branch, so this only ever runs for a path already
 * proven to be strictly inside `worktreesRoot`). Returns `true` if it actually removed
 * something, `false` for the already-gone no-op, so the caller can word the branch-deletion
 * message accurately. Removes the folder only once every one of these holds, refusing (throwing
 * `worktree-failed`, touching nothing) otherwise:
 *
 * - it is a REAL directory: `lstat`, never `stat` (the symlink/junction case is normally
 *   already refused upstream; the check here is defence in depth against a TOCTOU race between
 *   that check and this call);
 * - it is then either EMPTY, or holds only a `.git` file -- and that file must be a regular
 *   file (never a symlink), its `gitdir:` line must resolve to STRICTLY inside THIS
 *   repository's own `.git/worktrees` admin area (never the admin area itself, and never
 *   another repository's), both sides canonicalised.
 *
 * TOCTOU hardening: every filesystem operation below acts on `targetReal`, the realpath of
 * `worktreePath` -- never the original, unresolved path -- so an intermediate component
 * swapped for a junction between the caller's containment check and the delete below can never
 * redirect `readdir`/`lstat`/`unlink`/`rmdir` outside the root.
 *
 * Never a recursive delete of unknown content: the empty-directory case uses a plain `rmdir`
 * (fails if anything is still inside), and the lone-`.git`-file case unlinks that one named
 * file before `rmdir`, rather than `rm -rf` the directory. */
async function removeOrphanedWorktreeFolder(repo: string, worktreePath: string): Promise<boolean> {
  let stat: Stats
  try {
    stat = await fs.lstat(worktreePath)
  } catch (err) {
    if (isEnoent(err)) return false // Not registered, no folder -- nothing to remove.
    wrapFsError(err, worktreePath)
  }
  if (stat.isSymbolicLink()) {
    throw new GitError('worktree-failed', orphanRefusalMessage(worktreePath, 'is-a-link'))
  }
  if (!stat.isDirectory()) {
    throw new GitError('worktree-failed', orphanRefusalMessage(worktreePath, 'not-a-directory'))
  }

  const targetReal = await fs.realpath(worktreePath).catch((err) => wrapFsError(err, worktreePath))

  const entries = await fs.readdir(targetReal).catch((err) => wrapFsError(err, worktreePath))
  if (entries.length === 0) {
    await fs.rmdir(targetReal).catch((err) => wrapFsError(err, worktreePath))
    return true
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
    const adminRoot = await canonicalPath(path.join(await gitCommonDir(repo), 'worktrees'))
    const pointsIntoThisRepo = (await canonicalPath(gitdirAbs)).startsWith(`${adminRoot}${path.sep}`)
    if (!pointsIntoThisRepo) {
      throw new GitError('worktree-failed', orphanRefusalMessage(worktreePath, 'foreign-gitdir'))
    }
    await fs.unlink(gitFilePath).catch((err) => wrapFsError(err, worktreePath))
    await fs.rmdir(targetReal).catch((err) => wrapFsError(err, worktreePath))
    return true
  }
  throw new GitError('worktree-failed', orphanRefusalMessage(worktreePath, 'not-empty'))
}

/**
 * Removes a Session's worktree however it currently stands (issue #599): the single entry point
 * `sessions.delete` should call instead of picking its own path with `fs.stat`.
 *
 * 1. A symlink/junction AT `worktreePath` itself is refused immediately, before any
 *    `fs.realpath` call could follow it to its target.
 * 2. `assertWithinWorktreesRoot` decides containment; `isRepoReadable` gates every git command
 *    below it, so a repository that is not its own recognised toplevel never has a single git
 *    command issued against it.
 * 3. Outside the root and missing: refuses only if git still has it registered (never removes
 *    anything in that case -- see `assertWithinWorktreesRoot`'s own doc comment); otherwise only
 *    the branch step runs.
 * 4. Inside the root, registered and NOT hand-emptied: a direct, targeted `git worktree remove
 *    --force`, then the branch (never the shared `removeWorktree` helper, which has its own
 *    unwrapped `branch -D` with no retry or plain-language wrapping).
 * 5. Inside the root, registered but hand-emptied: refuses immediately if the folder holds
 *    anything besides the already-known-absent `.git` file; otherwise `removeAdminEntryFor`
 *    clears exactly this one stale admin entry, then the folder.
 * 6. Inside the root, not registered: `removeOrphanedWorktreeFolder` decides the folder.
 * 7. The branch is deleted only if it still exists. A `branch -D` failure because the branch is
 *    checked out elsewhere always just throws a plain-language message naming that other
 *    worktree's path as DISPLAY TEXT ONLY -- never read, never `lstat`'d, never passed to any
 *    git or fs call (there is no retry that acts on it; see the PR history for why).
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
  const linkStat = await fs.lstat(worktreePath).then(
    (s: Stats | null) => s,
    (err: unknown) => {
      if (isEnoent(err)) return null
      wrapFsError(err, worktreePath)
    }
  )
  if (linkStat?.isSymbolicLink()) {
    throw new GitError('worktree-failed', orphanRefusalMessage(worktreePath, 'is-a-link'))
  }

  const containment = await assertWithinWorktreesRoot(repo, worktreePath)

  async function deleteBranchIfRequested(removedWorktree: boolean): Promise<void> {
    if (!opts.deleteBranch || !(await branchExists(repo, branch))) return
    try {
      await git(repo, ['branch', '-D', '--', branch])
    } catch (err) {
      if (!(err instanceof GitError) || !/used by worktree/i.test(err.message)) throw err
      const usedByMatch = /used by worktree at '(.*)'\s*$/im.exec(err.message)
      const holderPath = usedByMatch?.[1]
      const isMainCheckout =
        holderPath !== undefined &&
        (await canonicalPath(holderPath).catch(() => null)) === (await canonicalPath(repo).catch(() => null))
      const removedClause = removedWorktree ? 'Refract removed the worktree folder but did not delete' : 'Refract did not delete'
      const whereClause = holderPath ? ` at ${holderPath}` : ' elsewhere'
      const nextStep = isMainCheckout
        ? 'Switch that checkout to a different branch, then choose Delete again.'
        : 'Switch that checkout to a different branch (or, if its drive is connected and you no longer need it, remove that worktree), then choose Delete again.'
      throw new GitError('worktree-failed', `${removedClause} branch ${branch}: it is checked out${whereClause}. ${nextStep}`)
    }
  }

  if (!(await isRepoReadable(repo))) {
    let worktreeGone: boolean
    try {
      await fs.lstat(worktreePath)
      worktreeGone = false
    } catch (err) {
      if (!isEnoent(err)) wrapFsError(err, worktreePath)
      worktreeGone = true
    }
    if (worktreeGone) return
    throw new GitError(
      'worktree-failed',
      `Refract did not delete anything. It could not read the repository at ${repo} (moved, deleted, or no longer a git repository?), and the worktree folder ${worktreePath} still exists. Restore the repository, or move that folder somewhere safe yourself, then choose Delete again.`
    )
  }

  if (containment === 'outside-missing') {
    if (await isWorktreeRegistered(repo, worktreePath)) {
      throw new GitError(
        'worktree-failed',
        `Refract did not delete anything. Git still records a worktree for this Session at ${worktreePath}, outside Refract's worktree folder, but that folder cannot be found (a disconnected drive, or moved?). Reconnect it and choose Delete again, or if you no longer need it run \`git worktree remove --force\` on that path yourself.`
      )
    }
    await deleteBranchIfRequested(false)
    return
  }

  const registered = await isWorktreeRegistered(repo, worktreePath)

  if (registered && (await isRegisteredButHandEmptied(worktreePath))) {
    const entries = await fs.readdir(worktreePath).catch((err) => wrapFsError(err, worktreePath))
    if (entries.length > 0) {
      throw new GitError('worktree-failed', orphanRefusalMessage(worktreePath, 'registered-not-empty'))
    }
    await removeAdminEntryFor(repo, worktreePath)
    await fs.rmdir(worktreePath).catch((err) => wrapFsError(err, worktreePath))
    await deleteBranchIfRequested(true)
    return
  }

  if (registered) {
    const result = await gitRaw(repo, ['worktree', 'remove', '--force', '--', worktreePath])
    if (result.code !== 0) {
      const stderr = result.stderr.trim() || result.stdout.trim()
      if (/locked working tree/i.test(stderr)) {
        throw new GitError('worktree-failed', lockedWorktreeMessage(worktreePath))
      }
      if (/permission denied|resource busy|being used by another process|access is denied/i.test(stderr)) {
        throw new GitError(
          'worktree-failed',
          `Refract could not finish removing ${worktreePath} because another program may be using it. Close any terminal or editor open in that folder, then choose Delete again.`
        )
      }
      throw new GitError('worktree-failed', `git worktree remove failed: ${stderr}`)
    }
    await deleteBranchIfRequested(true)
    return
  }

  const removedFolder = await removeOrphanedWorktreeFolder(repo, worktreePath)
  await deleteBranchIfRequested(removedFolder)
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

/** Feeds `sessions.deleteCheck` when the worktree folder itself is gone (registered but
 * missing, or unregistered and already gone): there is no checked-out working tree to run
 * `git status`/`HEAD` against, so this reads `branch`'s own commit graph from `repo` directly
 * instead. The zero-risk placeholder this replaces let a user confirm a delete that silently
 * destroyed a branch's unpushed commits, because `fs.stat` failing on the folder told the
 * dialog nothing was at risk, when `removeSessionWorktree` can still force-remove a registered
 * entry and `branch -D` the branch underneath it. `uncommittedFiles` stays 0 (there is no
 * working tree left to hold them); a branch that no longer exists reports no risk, since there
 * is nothing left for a delete to destroy. */
export async function deleteCheckForMissingWorktree(repo: string, branch: string): Promise<DeleteCheck> {
  if (!(await branchExists(repo, branch))) {
    return { uncommittedFiles: 0, unpushedCommits: 0, hasUpstream: false }
  }
  const ref = `refs/heads/${branch}`
  const upstream = await gitRaw(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${ref}@{u}`])
  const hasUpstream = upstream.code === 0
  const countOutput = await git(repo, ['rev-list', '--count', ref, '--not', '--remotes'])
  const unpushedCommits = Number.parseInt(countOutput.trim(), 10) || 0
  return { uncommittedFiles: 0, unpushedCommits, hasUpstream }
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
