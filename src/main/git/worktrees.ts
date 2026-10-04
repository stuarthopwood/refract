// Worktree lifecycle for a Session (data-model.md `Session.worktreePath`/`branch`, tasks.md T011).
// One Session = one git worktree, created under `<repo>/../pinion-worktrees/<repoName>/<name>`.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { git, gitRaw, GitError } from './git'
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
