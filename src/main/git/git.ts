// Low-level git access: a shell-free `execFile` wrapper and the typed errors every git-backed
// module in `src/main/git` throws (contracts/omp-usage.md and tasks.md T011).

import { execFile, type ExecFileException } from 'node:child_process'
import path from 'node:path'
import { resolveExecutable } from '../process/executables'

export type GitErrorCode =
  | 'not-a-repo'
  | 'no-commits'
  | 'git-failed'
  | 'worktree-failed'
  | 'base-missing'
  | 'path-too-long'
  | 'branch-missing'
  | 'checkout-failed'

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

/** Environment variables that redirect git to a DIFFERENT repository than `cwd` says (set by an
 * unrelated tool, a shell profile, or a parent process) would otherwise let every caller of
 * `gitRaw`/`git` -- not just the delete path -- silently operate on the wrong repository (for
 * example `GIT_DIR` pointed at another repo and a `branch -D` deleted a branch there instead).
 * Stripped for every invocation, so every current and future caller in this module gains the
 * same protection, not just `removeSessionWorktree`. Matched CASE-INSENSITIVELY on every
 * platform: `{ ...process.env }` preserves whatever casing the variable was actually set with,
 * and Windows environment lookups are case-insensitive, so deleting only `env['GIT_DIR']` would
 * leave a `git_dir` or `Git_Dir` override in place for git to still honour, letting a
 * mixed-case override redirect a `branch -D` to an unrelated repository. `GIT_CEILING_DIRECTORIES`
 * is deliberately kept: it only ever narrows git's own upward search, never redirects it to an
 * unrelated repository, so it adds safety rather than risk. */
const GIT_ENV_VARS_TO_STRIP: Record<string, true> = {
  GIT_DIR: true,
  GIT_WORK_TREE: true,
  GIT_COMMON_DIR: true,
  GIT_INDEX_FILE: true,
  GIT_OBJECT_DIRECTORY: true,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: true,
  GIT_NAMESPACE: true
}

function sanitizedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (GIT_ENV_VARS_TO_STRIP[key.toUpperCase()]) continue
    env[key] = value
  }
  return env
}

/** Runs `git <args>` with no shell in `cwd`. Never rejects; callers branch on `.code`. Resolves
 * git's absolute path via `resolveExecutable` (security: Windows would otherwise search `cwd`
 * before PATH for a bare `"git"`, so a repository that commits its own `git.exe` could run
 * instead of the real one). */
export async function gitRaw(cwd: string, args: string[], opts?: { signal?: AbortSignal }): Promise<GitRawResult> {
  let gitPath: string
  try {
    gitPath = await resolveExecutable('git')
  } catch (err) {
    return { stdout: '', stderr: err instanceof Error ? err.message : String(err), code: 1 }
  }
  return new Promise((resolve) => {
    execFile(
      gitPath,
      args,
      { cwd, windowsHide: true, signal: opts?.signal, env: sanitizedGitEnv() },
      (error: ExecFileException | null, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr, code: 0 })
          return
        }
        const code = typeof error.code === 'number' ? error.code : 1
        resolve({ stdout, stderr: stderr || error.message, code })
      }
    )
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
