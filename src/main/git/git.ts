// Low-level git access: a shell-free `execFile` wrapper and the typed errors every git-backed
// module in `src/main/git` throws (contracts/omp-usage.md and tasks.md T011).

import { execFile, type ExecFileException } from 'node:child_process'
import path from 'node:path'

export type GitErrorCode =
  | 'not-a-repo'
  | 'no-commits'
  | 'git-failed'
  | 'worktree-failed'
  | 'base-missing'
  | 'path-too-long'
  | 'branch-missing'

export class GitError extends Error {
  readonly code: GitErrorCode

  constructor(code: GitErrorCode, message: string) {
    super(message)
    this.name = 'GitError'
    this.code = code
  }
}

export interface GitRawResult {
  stdout: string
  stderr: string
  /** Process exit code; `0` on success. A spawn failure (e.g. git missing from PATH) is `1`. */
  code: number
}

/** Runs `git <args>` with no shell in `cwd`. Never rejects; callers branch on `.code`. */
export function gitRaw(cwd: string, args: string[]): Promise<GitRawResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true }, (error: ExecFileException | null, stdout, stderr) => {
      if (error === null) {
        resolve({ stdout, stderr, code: 0 })
        return
      }
      const code = typeof error.code === 'number' ? error.code : 1
      resolve({ stdout, stderr: stderr || error.message, code })
    })
  })
}

/** Runs `git <args>` and returns trimmed stdout; throws `GitError('git-failed', …)` on a non-zero exit. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await gitRaw(cwd, args)
  if (result.code !== 0) {
    throw new GitError('git-failed', `git ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result.stdout
}

export interface RepoInfo {
  /** Canonical absolute path of the main checkout (the repository's toplevel). */
  path: string
}

/**
 * Validates that `repoPath` is a git repository with at least one commit, per T011: `not-a-repo`
 * when `rev-parse --show-toplevel` fails, `no-commits` when `rev-parse HEAD` fails.
 */
export async function repoInfo(repoPath: string): Promise<RepoInfo> {
  const top = await gitRaw(repoPath, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0) {
    throw new GitError('not-a-repo', `Not a git repository: ${repoPath}`)
  }
  const toplevel = normalizeGitPath(top.stdout.trim())

  const head = await gitRaw(toplevel, ['rev-parse', 'HEAD'])
  if (head.code !== 0) {
    throw new GitError('no-commits', `Repository has no commits: ${repoPath}`)
  }

  return { path: toplevel }
}

/**
 * Git for Windows prints toplevel paths with forward slashes; normalise to the platform
 * separator and uppercase drive letter so later comparisons only need `.toLowerCase()`.
 */
export function normalizeGitPath(p: string): string {
  const withPlatformSeps = path.normalize(p.replace(/\//g, path.sep))
  return /^[a-z]:/.test(withPlatformSeps) ? withPlatformSeps[0]!.toUpperCase() + withPlatformSeps.slice(1) : withPlatformSeps
}
