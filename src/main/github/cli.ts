// GitHub CLI (`gh`) access: an execFile-based wrapper mirroring src/main/git/git.ts's shape,
// plus the auth-specific commands specs/008-profile-and-accounts needs (research.md decisions
// 1-2, contracts/ipc.md "GitHub accounts").

import { execFile, spawn, type ExecFileException, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { resolveExecutable, taskkillPath } from '../process/executables'

// `gh auth login --web` does not exit on stdin EOF while it polls for authorisation (measured: still
// running after 10 s, only `taskkill` ended it), so a long grace just makes Cancel feel broken. Keep a
// short one so a process that does exit on its own is not force-killed needlessly (contracts/ipc.md:
// "after a short grace"). A pre-completion kill never touches the stored credential (T001).
const CANCEL_GRACE_MS = 750

export type GhErrorCode = 'gh-not-found' | 'gh-failed'

export class GhError extends Error {
  readonly code: GhErrorCode

  constructor(code: GhErrorCode, message: string) {
    super(message)
    this.name = 'GhError'
    this.code = code
  }
}

export interface GhRawResult {
  stdout: string
  stderr: string
  /** Process exit code; `0` on success. A spawn failure (e.g. `gh` missing from PATH) is `1`. */
  code: number
  /** `true` only when `gh` itself could not be resolved on PATH; distinguishes "not installed"
   * from an ordinary non-zero exit, which `code: 1` alone cannot. */
  notFound: boolean
}

/** Runs `gh <args>` with no shell, in `cwd` when given. Never rejects; callers branch on
 * `.code`/`.notFound`. Resolves gh's absolute path via `resolveExecutable` (same PATH-ordering
 * rationale as git.ts's `gitRaw`: never trust a bare `"gh"` to avoid a cwd-planted binary). */
export async function ghRaw(args: string[], opts?: { cwd?: string; signal?: AbortSignal }): Promise<GhRawResult> {
  let ghPath: string
  try {
    ghPath = await resolveExecutable('gh')
  } catch (err) {
    return { stdout: '', stderr: err instanceof Error ? err.message : String(err), code: 1, notFound: true }
  }
  return new Promise((resolve) => {
    execFile(
      ghPath,
      args,
      { cwd: opts?.cwd, windowsHide: true, signal: opts?.signal },
      (error: ExecFileException | null, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr, code: 0, notFound: false })
          return
        }
        const code = typeof error.code === 'number' ? error.code : 1
        resolve({ stdout, stderr: stderr || error.message, code, notFound: false })
      }
    )
  })
}

/** Runs `gh <args>` and returns trimmed stdout; throws `GhError('gh-not-found', …)` when `gh`
 * is not on PATH, else `GhError('gh-failed', …)` on a non-zero exit. */
export async function gh(args: string[], opts?: { cwd?: string }): Promise<string> {
  const result = await ghRaw(args, opts)
  if (result.notFound) {
    throw new GhError('gh-not-found', result.stderr)
  }
  if (result.code !== 0) {
    throw new GhError('gh-failed', `gh ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result.stdout
}

export interface GhAuthHostEntry {
  host: string
  login: string
  active: boolean
  state: string
}

interface GhAuthStatusHostAccount {
  host?: string
  login?: string
  active?: boolean
  state?: string
}

interface GhAuthStatusJson {
  hosts?: Record<string, GhAuthStatusHostAccount[]>
}

/**
 * Runs `gh auth status --json hosts` and flattens every host's account array into one list
 * (research.md decision 1). The single-account-per-host shape (`host`, `login`, `active`,
 * `state`) was verified live (research.md Decision 1, re-confirmed by T001 2026-10-05). The
 * two-or-more-account-per-host array shape was verified live on 2026-10-05 against a scratch
 * `GH_CONFIG_DIR` holding fake accounts (research.md Decision 2): `gh` returns one array per
 * host with the active account listed first, each entry carrying the same already-verified
 * fields (`host`, `login`, `active`, `state`) plus `error`/`tokenSource`/`gitProtocol`, which
 * this parser already tolerates since it only reads the four fields above.
 *
 * `gh auth status` exits non-zero when nobody is signed in to any host at all, but `--json`
 * still writes a parseable (near-empty) body to stdout in that case; a non-empty stdout body is
 * treated as authoritative regardless of exit code, and `gh-failed` is raised both when stdout
 * itself is not JSON (a real CLI/transport failure, not "signed out") AND when stdout is empty
 * on a non-zero exit (GateCode008 MEDIUM: an older `gh` without `--json` support on `auth
 * status` prints only to stderr in that case, which must surface as a failure, not a silent
 * "signed out").
 */
export async function authStatus(): Promise<GhAuthHostEntry[]> {
  const result = await ghRaw(['auth', 'status', '--json', 'hosts'])
  if (result.notFound) {
    throw new GhError('gh-not-found', result.stderr)
  }
  let parsed: GhAuthStatusJson
  if (!result.stdout.trim()) {
    if (result.code !== 0) {
      throw new GhError('gh-failed', `gh auth status --json hosts failed: ${result.stderr.trim() || 'no output'}`)
    }
    parsed = {}
  } else {
    try {
      parsed = JSON.parse(result.stdout) as GhAuthStatusJson
    } catch {
      throw new GhError('gh-failed', `gh auth status --json hosts returned unparseable output: ${result.stderr.trim() || result.stdout.trim()}`)
    }
  }
  const hosts = parsed.hosts ?? {}
  const entries: GhAuthHostEntry[] = []
  for (const [hostKey, accounts] of Object.entries(hosts)) {
    for (const account of accounts) {
      entries.push({
        host: account.host ?? hostKey,
        login: account.login ?? '',
        active: account.active === true,
        state: account.state ?? 'unknown',
      })
    }
  }
  return entries
}

/** Runs `gh auth token --hostname <host> --user <login>` and returns the trimmed token.
 * Reads a *non*-active account's token without an `gh auth switch` side effect (research.md
 * decision 3), verified live via `gh auth token --help`'s documented `--hostname`/`--user`
 * flags; callers must never persist the returned value (FR-012). */
export async function authToken(host: string, login: string): Promise<string> {
  const token = await gh(['auth', 'token', '--hostname', host, '--user', login])
  return token.trim()
}

export interface GhLoginExitInfo {
  code: number | null
  requested: boolean
}

/**
 * Drives one `gh auth login --hostname <host> --web` child process and streams its stdout,
 * line by line, as `'line'` events — the one-time code and device URL (FR-009) arrive this way,
 * never by re-parsing a finished run.
 *
 * Exact non-tty stdout captured live by T001's probe (research.md Decision 2, 2026-10-05):
 * ```
 * ! One-time code (5FCF-5515) copied to clipboard
 * Open this URL to continue in your web browser: https://github.com/login/device
 * ```
 * The attached-terminal variant (a possible extra "press Enter" prompt) was never observed by
 * that probe and is not assumed here; only the two lines above are parsed for a one-time code,
 * emitted as `'code'` when the `One-time code (...)` line is seen.
 *
 * Events: `'line'` (raw stdout line, trimmed), `'code'` (the parsed one-time code string),
 * `'exit'` (`GhLoginExitInfo`, fires exactly once). `cancel()` mirrors `OmpProcess.stop()`'s
 * two-step shutdown: stdin close, then `taskkill /T /F` after a grace period if the process has
 * not exited on its own (per T001's confirmation that a pre-completion kill never touches the
 * stored credential).
 */
export class GhLoginFlow extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | undefined
  private stdoutBuf = ''
  private requested = false
  private exited = false
  private exitWaiters: Array<() => void> = []
  private stopPromise: Promise<void> | undefined

  /** Spawns the child; resolves once spawned (not once signed in — the flow keeps running). */
  async start(host: string): Promise<void> {
    const ghPath = await resolveExecutable('gh')
    const child = spawn(ghPath, ['auth', 'login', '--hostname', host, '--web'], { windowsHide: true })
    this.child = child
    child.stdout.on('data', (chunk: Buffer) => this.onStdoutData(chunk))
    child.stderr.on('data', (chunk: Buffer) => this.onStdoutData(chunk))
    child.on('exit', (code) => this.onExit(code))
    // A spawn failure (EACCES, the binary removed after resolveExecutable cached its path, AV
    // quarantine) emits 'error' with no 'exit' to follow; without a listener here it would be an
    // uncaught exception in the main process, and the flow would stay in activeAddFlows forever
    // (GateSec008 MEDIUM / GateCode008 MEDIUM). onExit's own guard makes this safe even if
    // 'exit' somehow also fires for the same child.
    child.on('error', () => this.onExit(null))
    // cancel()'s stdin.end() on an already-closed pipe can emit an async EPIPE 'error'; without
    // a listener that is also an uncaught exception (same findings as above).
    child.stdin.on('error', () => undefined)
  }

  /** Idempotent: stdin close, then force-kill via taskkill after a 750ms grace
   * (`CANCEL_GRACE_MS`) if the process has not exited on its own. */
  async cancel(): Promise<void> {
    this.requested = true
    if (!this.stopPromise) {
      this.stopPromise = this.doCancel()
    }
    return this.stopPromise
  }

  private async doCancel(): Promise<void> {
    if (!this.child || this.exited) return
    try {
      this.child.stdin.end()
    } catch (err) {
      console.error('GhLoginFlow: stdin.end() failed', err)
    }
    const exited = await this.waitForExit(CANCEL_GRACE_MS)
    if (!exited) {
      await this.hardKill()
    }
  }

  private async hardKill(): Promise<void> {
    const pid = this.child?.pid
    if (pid === undefined || this.exited) return
    /* Executor form: see git.ts's `gitRaw`/OmpProcess's `start()` for why
     * `Promise.withResolvers()` isn't available here (tsconfig.node.json pins ES2023). */
    await new Promise<void>((resolve) => {
      execFile(taskkillPath(), ['/PID', String(pid), '/T', '/F'], () => resolve())
    })
    await new Promise<void>((resolve) => {
      if (this.exited) {
        resolve()
        return
      }
      this.exitWaiters.push(resolve)
    })
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true)
    /* Executor form: see above. */
    return new Promise((resolve) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        resolve(false)
      }, timeoutMs)
      this.exitWaiters.push(() => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  private onStdoutData(chunk: Buffer): void {
    this.stdoutBuf += chunk.toString('utf8')
    let newlineIndex: number
    while ((newlineIndex = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, newlineIndex).trim()
      this.stdoutBuf = this.stdoutBuf.slice(newlineIndex + 1)
      if (!line) continue
      this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    this.emit('line', line)
    const codeMatch = /One-time code \(([^)]+)\)/.exec(line)
    if (codeMatch?.[1]) {
      this.emit('code', codeMatch[1])
    }
  }

  private onExit(code: number | null): void {
    // Guards against a double call (the normal 'exit' event firing after an 'error' already
    // called this with code null, or vice-versa) -- without this, 'exit' would emit twice and
    // callers (e.g. accounts.ts's ADD_START handler) would broadcast a completed/failed add flow
    // twice (GateCode008 MEDIUM "GhLoginFlow 'error' handling").
    if (this.exited) return
    this.exited = true
    if (this.stdoutBuf.trim()) {
      this.handleLine(this.stdoutBuf)
      this.stdoutBuf = ''
    }
    const waiters = this.exitWaiters
    this.exitWaiters = []
    for (const waiter of waiters) waiter()
    this.emit('exit', { code, requested: this.requested } satisfies GhLoginExitInfo)
  }
}

/** Starts a `gh auth login --hostname <host> --web` flow (FR-009); see `GhLoginFlow` for the
 * event/cancel contract. */
export async function authLoginStart(host: string): Promise<GhLoginFlow> {
  const flow = new GhLoginFlow()
  await flow.start(host)
  return flow
}

/** Cancels `flow` (stdin close, then force-kill after a grace period). A thin alias over
 * `GhLoginFlow.cancel()` for callers that only hold the flow, not its class. */
export async function authLoginCancel(flow: GhLoginFlow): Promise<void> {
  await flow.cancel()
}

/**
 * Runs `gh auth switch --hostname <host> --user <login>`.
 *
 * Verified live against a scratch `GH_CONFIG_DIR` (research.md Decision 2, 2026-10-05, T001): a
 * matching `--user` (e.g. `--hostname github.com --user bob-test`) exits 0 in ~145 ms with EMPTY
 * stdout and `✓ Switched active account for github.com to bob-test` on stderr. A `--user` that
 * does not match any existing account on that host (e.g. `--user nobody-test`) exits 1 with
 * empty stdout and stderr `not logged in to github.com account nobody-test` — confirming
 * `GhError('gh-failed', …)` is exactly what a non-matching `--user` surfaces as.
 */
export async function authSwitch(host: string, login: string): Promise<void> {
  await gh(['auth', 'switch', '--hostname', host, '--user', login])
}

/**
 * Runs `gh auth logout --hostname <host> --user <login>`.
 *
 * Verified live against a scratch `GH_CONFIG_DIR` (research.md Decision 2, 2026-10-05, T001): a
 * matching `--user` (e.g. `--hostname github.com --user bob-test`) exits 0 with empty stdout and
 * stderr `✓ Logged out of github.com account bob-test`, followed by `✓ Switched active account
 * for github.com to alice-test` when another account on that host became the new active one. A
 * `--user` that does not match any existing account on that host exits 1 with empty stdout and
 * the same `not logged in to github.com account <user>` stderr `authSwitch` above documents.
 */
export async function authLogout(host: string, login: string): Promise<void> {
  await gh(['auth', 'logout', '--hostname', host, '--user', login])
}
