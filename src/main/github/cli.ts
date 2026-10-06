// GitHub CLI (`gh`) access: an execFile-based wrapper mirroring src/main/git/git.ts's shape,
// plus the auth-specific commands specs/008-profile-and-accounts needs (research.md decisions
// 1-2, contracts/ipc.md "GitHub accounts").
//
// The actual exec/resolve/timeout core (`ghRaw`, `GhError`, `GhErrorCode`, `GhRawResult`) lives
// in `./gh.ts` (spec 003's PR-management wrapper) and is reused here rather than duplicated
// (GateCode008 MEDIUM "two gh wrappers"): this file's own former copy of `ghRaw` had no timeout
// at all, so `gh auth status`/`auth token`/`auth switch`/`auth logout`/`addStart`'s pre-flight
// `authStatus()` could hang forever on a wedged `gh`. The account commands below keep their own
// `'gh-not-found'`/`'gh-failed'` vocabulary via `ghRaw`'s additive `notFoundCode` option, kept
// distinct from spec 003's `'gh-unavailable'`/`'github-failed'` without touching spec 003's own
// call sites. The long-lived interactive `GhLoginFlow` below (`gh auth login --web`) is a
// `spawn()`, not a single timed `execFile` call, so it is intentionally NOT folded onto `ghRaw`.

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import { resolveExecutable, taskkillPath } from '../process/executables'
import { GhError, ghRaw, type GhErrorCode } from './gh'

export { GhError }
export type { GhErrorCode }

// `gh auth login --web` does not exit on stdin EOF while it polls for authorisation (measured: still
// running after 10 s, only `taskkill` ended it), so a long grace just makes Cancel feel broken. Keep a
// short one so a process that does exit on its own is not force-killed needlessly (contracts/ipc.md:
// "after a short grace"). A pre-completion kill never touches the stored credential (T001).
const CANCEL_GRACE_MS = 750

// Account commands are host/login-scoped, never repo-scoped, so there is no repository path to
// hand `ghRaw` as `cwd` -- `os.tmpdir()` is the same neutral choice `readiness.ts`'s `checkGit`
// already makes for `gitRaw(os.tmpdir(), ['--version'])`.
const ACCOUNT_CWD = os.tmpdir()

/** Runs `gh <args>` via the shared timed/resolved runner (`./gh.ts`'s `ghRaw`, 15s
 * `AbortController` timeout) and returns trimmed stdout. Throws `GhError('gh-not-found', …)`
 * when `gh` is not on PATH, `GhError('timeout', …)` if the 15s timeout fires, else
 * `GhError('gh-failed', …)` on a non-zero exit -- the message is built from stderr only (or a
 * fixed string), NEVER stdout, which can be a secret (e.g. `auth token`'s token). */
async function gh(args: string[]): Promise<string> {
  const result = await ghRaw(ACCOUNT_CWD, args, { notFoundCode: 'gh-not-found' })
  if (result.timedOut) {
    throw new GhError('timeout', `gh ${args[0] ?? ''} did not respond within the timeout.`)
  }
  if (result.code !== 0) {
    throw new GhError('gh-failed', `gh ${args.join(' ')} failed: ${result.stderr.trim() || 'no output'}`)
  }
  return result.stdout.trim()
}

export type GhAccountProblem = 'expired' | 'unreachable' | 'unknown'

export interface GhAuthHostEntry {
  host: string
  login: string
  active: boolean
  state: string
  /** Set when `state !== 'success'`; classified from gh's per-account `error` text (never the
   * raw text itself -- GateSec008/GateUi008: the renderer and logs must never see it). Mirrors
   * `GitHubAccount.problem` in src/shared/ipc.ts. */
  problem?: GhAccountProblem
}

interface GhAuthStatusHostAccount {
  host?: string
  login?: string
  active?: boolean
  state?: string
  /** `gh`'s per-account failure detail (e.g. an expired/invalid token, a network error) --
   * classified into `GhAccountProblem` below and never itself stored on `GhAuthHostEntry` or
   * exposed to the renderer/logs. */
  error?: string
}

interface GhAuthStatusJson {
  hosts?: Record<string, GhAuthStatusHostAccount[]>
}

/** Classifies a non-success account entry's `error` text into one of the three fixed
 * `GhAccountProblem` buckets (UI N5) -- undefined for a successful account. The raw `error`
 * text itself is read only here and never stored or returned (GateSec008/GateUi008: it must
 * never reach the renderer or any log). */
function classifyAccountProblem(state: string, error: string | undefined): GhAccountProblem | undefined {
  if (state === 'success') return undefined
  if (state === 'timeout') return 'unreachable'
  const text = error ?? ''
  if (/401|bad credentials|token.*(invalid|expired|revoked)|re-?authenticate|authentication failed/i.test(text)) {
    return 'expired'
  }
  if (/timeout|timed out|dial tcp|no such host|ENOTFOUND|ECONN|network|unreachable|offline|EAI_AGAIN|tls|certificate/i.test(text)) {
    return 'unreachable'
  }
  return 'unknown'
}

/**
 * Runs `gh auth status --json hosts` and flattens every host's account array into one list
 * (research.md decision 1). The single-account-per-host shape (`host`, `login`, `active`,
 * `state`) was verified live (research.md Decision 1, re-confirmed by T001 2026-10-05). The
 * two-or-more-account-per-host array shape was verified live on 2026-10-05 against a scratch
 * `GH_CONFIG_DIR` holding fake accounts (research.md Decision 2): `gh` returns one array per
 * host with the active account listed first, each entry carrying the same already-verified
 * fields (`host`, `login`, `active`, `state`) plus `tokenSource`/`gitProtocol`, which this
 * parser already tolerates, and `error`, now read to classify `problem` below.
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
  const result = await ghRaw(ACCOUNT_CWD, ['auth', 'status', '--json', 'hosts'], { notFoundCode: 'gh-not-found' })
  if (result.timedOut) {
    throw new GhError('timeout', 'gh auth status did not respond within the timeout.')
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
        problem: classifyAccountProblem(account.state ?? 'unknown', account.error),
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
  /** Short, plain-language reason when the flow ended in failure (`code !== 0`, not
   * `requested`); absent on success/cancel. Classified from the exit code and a short internal
   * stderr tail -- NEVER the raw stderr itself, which can carry a command line or token
   * (GateUi008 M5). */
  detail?: string
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
  // GateUi008 M5: the last 2 KB of stderr, kept only to classify a failed exit into one of the
  // four fixed `detail` sentences below -- never logged, never emitted, never leaves this class.
  private static readonly STDERR_TAIL_BYTES = 2 * 1024

  private child: ChildProcessWithoutNullStreams | undefined
  private stdoutBuf = ''
  private stderrTail = ''
  private requested = false
  private exited = false
  private exitWaiters: Array<() => void> = []
  private stopPromise: Promise<void> | undefined

  /** Spawns the child; resolves once spawned (not once signed in — the flow keeps running). */
  async start(host: string): Promise<void> {
    let ghPath: string
    try {
      ghPath = await resolveExecutable('gh')
    } catch {
      throw new GhError('gh-not-found', 'The GitHub CLI (gh) is not installed or not on PATH.')
    }
    const child = spawn(ghPath, ['auth', 'login', '--hostname', host, '--web'], { windowsHide: true })
    this.child = child
    child.stdout.on('data', (chunk: Buffer) => this.onStdoutData(chunk))
    child.stderr.on('data', (chunk: Buffer) => this.onStdoutData(chunk))
    child.stderr.on('data', (chunk: Buffer) => this.onStderrTailData(chunk))
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
    const detail = !this.requested && code !== 0 ? this.classifyFailure() : undefined
    this.emit('exit', { code, requested: this.requested, detail } satisfies GhLoginExitInfo)
  }

  private onStderrTailData(chunk: Buffer): void {
    this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-GhLoginFlow.STDERR_TAIL_BYTES)
  }

  /** Classifies a failed `gh auth login` run into one of four short, plain-language sentences
   * (GateUi008 M5) using only the exit code and the stderr tail above -- the raw stderr text
   * itself never leaves this method, is never logged, and is never emitted. */
  private classifyFailure(): string {
    const tail = this.stderrTail.toLowerCase()
    if (/expired/.test(tail)) return 'The code expired.'
    if (/declined|denied|access_denied/.test(tail)) return 'GitHub declined the sign-in.'
    if (/network|timeout|dial|enotfound/.test(tail)) return "Couldn't reach GitHub."
    return 'Sign-in did not finish.'
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
