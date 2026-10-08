// Drives one `omp --mode rpc-ui` child process for a single Session's worktree.
// Wire contract: specs/001-core-session-workspace/contracts/omp-usage.md ("Launch",
// "Start-up sequence", "Frames Refract consumes", "Commands Refract sends"). Frame and
// command shapes: src/shared/frames.ts.
//
// Events:
//   'frame' (Frame)  every decoded frame except `response` frames, which are consumed
//                     internally by request() and never emitted (constitution: one way
//                     to read a response).
//   'exit'  ({ code: number | null; requested: boolean })  fires exactly once.
//   'start-progress' (ReadyWaitStage)  staged ready-wait progress during start() (issue
//                     #512: "Starting agent… N s"); never fires outside an in-flight start().
//   'start-queued' ()  emitted the instant start() actually has to wait for a process-wide
//                     start slot (issue #512 requirement 5, startQueue.ts), before the wait
//                     begins, not after it ends; never fires when a slot was free and granted
//                     immediately.
//   'start-memory-deferred' ({ elapsedMs: number })  emitted while start() defers because
//                     free memory is low (issue #512 requirement 5, reuses memory.ts).

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import { type ApprovalMode, OMP_APPROVAL_MODE, READY_CEILING_MS } from '../../shared/model'
import type { Frame, ReadyFrame, ResponseFrame, RpcChunkFrame, RpcCommand } from '../../shared/frames'
import { tailOmpLogForPid } from './ompLogTail'
import { redactSecrets } from './redact'
import { ReadyWaitController, type ReadyWaitStage } from './readyWait'
import { acquireStartSlot, markSpawned, spawnedInFlight, unmarkSpawned } from './startQueue'
import { isMemoryLow } from '../memory'
import { recordProcess, removeProcessRecord } from '../process/pidRecords'
import { resolveExecutable, taskkillPath } from '../process/executables'

// Issue #512: a single fixed 60s cutoff killed a slow-but-healthy start with no progress
// and no reason shown. READY_PROMPT_AFTER_MS is now only the point at which the caller
// should offer "Keep waiting"/"Cancel" (see ReadyWaitController); the wait keeps going
// regardless, up to `READY_CEILING_MS` (imported from `shared/model.ts` -- gate-fixes Low
// finding, cycle 6: ChatPane.tsx's own announcement-only estimate used to hand-keep a SEPARATE
// constant of the same value, with no link between the two), where it fails outright. Both are
// overridable per `OmpProcessOptions`, per caller (the readiness/login-provider probes pass
// shorter values; no production Settings surface wires either one yet).
const READY_PROMPT_AFTER_MS = 60_000
// Issue #512 requirement 5: how long a start will defer while memory.ts's isMemoryLow()
// says the machine is under pressure, before giving up and spawning anyway (never defers
// forever: that would just be a quieter version of the #512 bug it fixes).
const MEMORY_DEFER_POLL_MS = 2_000
const MEMORY_DEFER_CEILING_MS = 60_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const STOP_GRACE_MS = 10_000
const STDERR_TAIL_BYTES = 4 * 1024
const STDERR_FAILURE_TAIL_BYTES = 2 * 1024
// Issue #512 requirement 2: the tail of that pid's own `~/.omp/logs` file, appended to a
// start failure alongside the stderr tail (OMP logs to its own file, not stderr).
// Gate-fixes Medium finding (cycle 6): OMP's debug JSON lines run only a few hundred bytes
// each, so reading just `OMP_LOG_TAIL_BYTES` worth of RAW log before filtering to warn/error
// lines routinely held only 8-15 lines total, pushing the real warning/error out. Reads this
// much larger window first; `buildStartFailure` caps the FILTERED result at `OMP_LOG_TAIL_BYTES`.
const OMP_LOG_READ_WINDOW_BYTES = 64 * 1024
const OMP_LOG_TAIL_BYTES = 4 * 1024
// FINDINGS C22b: v1 frames are capped at maxFrameBytes; a reassembled rpc_chunk sequence
// above this ceiling is treated as corrupt rather than buffered without bound.
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024

/** Thrown specifically when the ready-wait's ceiling is reached with nobody cancelling (gate-
 * fixes Medium finding: a caller used to tell this apart from every other start failure by
 * regex-matching the error message, which also carries the appended stderr/log tail and would
 * silently stop matching if that wording ever changed). Carries the same full message
 * (hint/stderr/log tail included) as every other start failure; only its type differs. */
export class ReadyCeilingError extends Error {}

export interface OmpProcessOptions {
  cwd: string
  approvalMode: ApprovalMode
  sessionId: string
  ompPath?: string
  /** Appends `--no-session` so the process never persists a session-store folder under
   * `~/.omp/agent/sessions` (omp-usage.md's `--no-session` flag; issue #362). Only safe for
   * callers that never issue `open_session` or any other command requiring persistence. */
  noSession?: boolean
  /** Overrides READY_PROMPT_AFTER_MS (issue #512 requirement 1), per caller -- no production
   * Settings surface wires this. */
  readyPromptAfterMs?: number
  /** Overrides READY_CEILING_MS (issue #512 requirement 1), per caller -- no production
   * Settings surface wires this. */
  readyCeilingMs?: number
  /** Gate-fixes Medium finding (cycle 2): an overall ceiling across the queue wait, the
   * memory defer AND the ready wait combined, not just the ready wait's own ceiling above --
   * readiness.ts/loginProviders.ts's probes need this so a slow Session start elsewhere can
   * never hold one of them hostage for longer than this, regardless of which phase it is stuck
   * in. Reuses `cancelStart()`'s own abort signal, so a deadline behaves exactly like an
   * external cancel once it fires. `undefined` (the default): no overall deadline, only the
   * phase-specific ceilings above apply (real Session starts: the ceiling screen shows "Keep
   * waiting"/"Cancel", so an invisible overall cutoff would be actively wrong for them). */
  startDeadlineMs?: number
  /** Gate-fixes High finding (cycle 5): the readiness/login-provider sign-in probes pass
   * `startDeadlineMs` to bound their *whole* wait, but `deferStartIfMemoryLow()` used to run
   * inside that same bound unconditionally -- under low memory its own up-to-60s wait routinely
   * ate the probe's entire deadline before the ready-wait even started, so the probe always
   * timed out and Refract stuck on the Readiness screen. `false`: skip the memory defer for
   * this `start()` entirely (the probes are short-lived, read-only checks; deferring them for
   * someone else's slow Session start is never worth it). Defaults to `true` (unset) for real
   * Session starts. */
  deferForMemory?: boolean
  /** Gate-fixes Medium finding (cycle 6): the readiness/login-provider probes' `startDeadlineMs`
   * bounds the queue wait, the memory defer, AND the ready wait combined -- but on a busy
   * machine where two slow Session starts each hold one of the process-wide queue's two slots
   * for up to 180s, a probe queued behind them could have its entire deadline expire while it
   * never even got a slot, well before the ready-wait phase it is actually meant to measure ever
   * began. Same reasoning as `deferForMemory: false` just one phase earlier: these probes are
   * short-lived, read-only checks that must never be starved behind someone else's slow Session
   * start. `false`: skip `acquireStartSlot()` entirely and spawn immediately, outside the
   * process-wide concurrency limit. Defaults to `true` (unset) for real Session starts, which
   * must still respect the limit. */
  useStartQueue?: boolean
}

interface PendingRequestEntry {
  resolve: (frame: ResponseFrame) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface ChunkAssembly {
  parts: Array<Buffer | undefined>
  got: number
  byteLength: number
}

export class OmpProcess extends EventEmitter {
  private readonly opts: OmpProcessOptions
  private child: ChildProcessWithoutNullStreams | undefined
  private stdoutBuf: Buffer = Buffer.alloc(0)
  private stderrBuf: Buffer = Buffer.alloc(0)
  private readonly chunks = new Map<string, ChunkAssembly>()
  private readonly pending = new Map<string, PendingRequestEntry>()
  private requestCounter = 0
  private requested = false
  private exited = false
  private exitEmitted = false
  private exitWaiters: Array<() => void> = []
  private stopPromise: Promise<void> | undefined
  private lastSpawnError: NodeJS.ErrnoException | undefined
  private readyWait: ReadyWaitController | undefined
  // Issue #512 gate-fixes High finding: cancelStart() used to only reach `readyWait`, which
  // does not exist yet while a start is still queued or deferring for memory, so a cancel (or
  // shutdown()) during either phase was silently lost and the process spawned anyway. Checked
  // right after the slot is granted and on every tick of the memory-defer poll.
  private startCancelled = false
  // Gate-fixes Low finding (cycle 2): the old `if (this.child)` guard only rejected a second
  // start() once the first had already spawned, so a second call made while the first was still
  // queued or deferring for memory (`this.child` not yet assigned) was not rejected. Set at the
  // very top of start(), before anything else.
  private startCalled = false
  // Gate-fixes High finding (cycle 2): lets cancelStart()/shutdown() abort the queue wait and the
  // memory-defer sleep immediately, instead of leaving them to find out via `startCancelled` only
  // on the next poll or once some other Session's start happens to free a slot.
  private startAbortController: AbortController | undefined
  // Issue #512 gate-fixes security finding: the pid's own spawn time, so `buildStartFailure`'s
  // omp log tail lookup never attributes an older, pid-reused process's log to this one.
  private spawnedAtMs: number | undefined
  // Gate-fixes Medium finding (cycle 6): tracks whether THIS instance called `markSpawned()`,
  // so the matching `unmarkSpawned()` in the slot-release `finally` runs exactly once per start
  // attempt that actually spawned -- never for one that failed before spawning (never marked)
  // or was already unmarked by an earlier path.
  private hasMarkedSpawned = false
  // Gate-fixes security Low finding (cycle 2): true once `onStderrData`'s own sliding window has
  // ever dropped bytes, so `buildStartFailure` knows `stderrTail`'s first line may be a truncated
  // fragment of a credential with no recognisable prefix left for `redactSecrets` to match, and
  // drops it before redacting.
  private stderrTruncated = false

  constructor(opts: OmpProcessOptions) {
    super()
    this.opts = opts
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  get stderrTail(): string {
    return this.stderrBuf.toString('utf8')
  }

  /** Spawns `omp` and resolves once the ready handshake (and v2 negotiation) completes. */
  async start(): Promise<void> {
    if (this.startCalled) {
      throw new Error('OmpProcess: start() already called')
    }
    this.startCalled = true

    const startAbort = new AbortController()
    this.startAbortController = startAbort
    // Gate-fixes High finding (cycle 3): a cancelStart()/shutdown() issued BEFORE start() is
    // ever called (SessionAgent.launch()'s own `if (this.stopRequested) proc.cancelStart()`,
    // right after assigning `this.startingProcess`) used to be lost entirely: `cancelStart()`
    // only set `startCancelled`, since this fresh AbortController did not exist yet for it to
    // abort. The queue wait then proceeded as if nothing had been cancelled, which could block
    // `shutdown()` behind another Session's start for minutes. Aborts immediately if a cancel
    // already landed before this point.
    if (this.startCancelled) startAbort.abort()
    // Gate-fixes Medium finding (cycle 2): see `OmpProcessOptions.startDeadlineMs` -- bounds the
    // queue wait, the memory defer and the ready wait combined, by reusing `cancelStart()`'s own
    // abort signal so expiry behaves exactly like an external cancel.
    const deadlineTimer =
      this.opts.startDeadlineMs !== undefined ? setTimeout(() => this.cancelStart(), this.opts.startDeadlineMs) : undefined

    try {
      // Issue #512 requirement 5: "start agents one or two at a time" plus "defer under low
      // memory". Every start() queues for a process-wide slot before spawning (startQueue.ts)
      // and, once granted, waits out a low-memory window (memory.ts's existing threshold)
      // before paying the heavy discovery/MCP/embedding-worker cost; the slot is released in
      // `finally` so a failed start never holds it. Gate-fixes High finding (cycle 2): the wait
      // is now abortable (`startAbort.signal`), so a cancelStart()/shutdown() that arrives while
      // still queued takes effect immediately instead of waiting out another Session's start.
      let releaseStartSlot: () => void
      if (this.opts.useStartQueue === false) {
        releaseStartSlot = () => {}
      } else {
        try {
          releaseStartSlot = await acquireStartSlot({
            onQueued: () => this.emit('start-queued'),
            signal: startAbort.signal,
          })
        } catch {
          throw await this.buildStartFailure('start cancelled')
        }
      }

      try {
        // Gate-fixes High finding: a cancelStart()/shutdown() that arrived while this start was
        // still queued or memory-deferred used to be lost entirely (`readyWait` does not exist
        // yet), so the process spawned anyway. Checked here and again after the memory defer.
        if (this.startCancelled) {
          throw await this.buildStartFailure('start cancelled')
        }
        await this.deferStartIfMemoryLow()
        if (this.startCancelled) {
          throw await this.buildStartFailure('start cancelled')
        }

        const ompPath = this.opts.ompPath ?? (await resolveExecutable('omp'))
        // Gate-fixes Medium finding (cycle 3): `resolveExecutable('omp')` is uncached the first
        // time the app runs it (readiness.ts/loginProviders.ts's probes run in parallel via
        // Promise.all, so this is the common case on a fresh launch), and it is the only await
        // between the last `startCancelled` check above and spawning below. A cancel/shutdown/
        // deadline that lands during it used to only reach the already-granted slot (released
        // early), not `readyWait` (which doesn't exist yet) -- so the process still spawned and
        // ran out its full ceiling. Closes that window before paying the spawn cost at all.
        if (this.startCancelled) {
          throw await this.buildStartFailure('start cancelled')
        }
        const args: string[] = ['--mode', 'rpc-ui', `--approval-mode=${OMP_APPROVAL_MODE[this.opts.approvalMode]}`]
        if (this.opts.noSession) {
          args.push('--no-session')
        }

        // stdio omitted: the default ('pipe' for all three streams) is exactly what the
        // contract asks for, and omitting it lets TypeScript pick the
        // ChildProcessWithoutNullStreams overload instead of the nullable-stream one.
        // Captured before spawning: `buildStartFailure`'s omp log tail lookup uses this to
        // reject an older, pid-reused process's log as "the real reason" for this one.
        this.spawnedAtMs = Date.now()
        const child = spawn(ompPath, args, {
          cwd: this.opts.cwd,
          windowsHide: true,
        })
        // Gate-fixes Medium finding (cycle 6): marks the instant a process actually spawns --
        // see `spawnedInFlight()`'s own doc comment for why this is a narrower, more accurate
        // signal than merely holding a queue slot.
        markSpawned()
        this.hasMarkedSpawned = true
        this.child = child

        child.on('error', (err: NodeJS.ErrnoException) => {
          this.lastSpawnError = err
          console.error('OmpProcess: child process error', err)
        })
        child.stdout.on('data', (chunk: Buffer) => this.onStdoutData(chunk))
        child.stderr.on('data', (chunk: Buffer) => this.onStderrData(chunk))
        child.on('exit', (code) => this.onExit(code))

        // Record the pid immediately after spawn returns, before wiring anything else that
        // could throw; Job Object membership is inherited, so this pid record is the fallback
        // protection if that job is ever lost.
        if (typeof child.pid === 'number') {
          recordProcess(child.pid, this.opts.sessionId).catch((err: unknown) => {
            console.error('OmpProcess: recordProcess failed', err)
          })
        }

        // Promise.withResolvers() would read cleaner here, but it needs lib "ES2024" and
        // tsconfig.node.json is pinned to "ES2023" (owned by another task); executor form kept.
        await new Promise<void>((resolve, reject) => {
          const cleanup = (): void => {
            this.readyWait = undefined
            readyWait.dispose()
            this.off('frame', onFrame)
            this.off('exit', onExitDuringStart)
            child.off('error', onSpawnErrorDuringStart)
          }

          // Issue #512: replaces the old single 60s `setTimeout` kill. The wait keeps going
          // regardless of the prompt stage; only the ceiling (or an explicit cancel) fails it.
          const readyWait = new ReadyWaitController({
            promptAfterMs: this.opts.readyPromptAfterMs ?? READY_PROMPT_AFTER_MS,
            ceilingMs: this.opts.readyCeilingMs ?? READY_CEILING_MS,
          })
          this.readyWait = readyWait
          readyWait.onStage((stage) => this.emit('start-progress', stage))
          readyWait.onOutcome((outcome) => {
            if (outcome.kind === 'ready') return
            cleanup()
            void (async () => {
              if (outcome.kind === 'cancelled') {
                reject(await this.buildStartFailure('start cancelled'))
                return
              }
              // Gate-fixes Medium finding: a typed error instead of a message-text regex, so
              // SessionAgent's one-shot retry can never be silently turned off by rewording this.
              reject(await this.buildStartFailure(`ready frame not seen within ${Math.round(outcome.elapsedMs / 1000)}s`, ReadyCeilingError))
            })()
          })
          readyWait.start()

          const onExitDuringStart = (info: { code: number | null; requested: boolean }): void => {
            cleanup()
            void (async () => {
              reject(await this.buildStartFailure(`process exited before ready (code ${String(info.code)})`))
            })()
          }
          this.once('exit', onExitDuringStart)

          // A spawn failure (e.g. ENOENT) does not reliably produce a child 'exit' event, so
          // fail fast here instead of waiting out the full ready wait.
          const onSpawnErrorDuringStart = (err: NodeJS.ErrnoException): void => {
            cleanup()
            void (async () => {
              reject(await this.buildStartFailure(`process failed to spawn: ${err.message}`))
            })()
          }
          child.once('error', onSpawnErrorDuringStart)

          const onFrame = (frame: Frame): void => {
            if (frame.type !== 'ready') return
            cleanup()
            readyWait.ready()
            // `type` narrowing alone can't isolate ReadyFrame from the Frame union because
            // UnknownFrame's index signature accepts any key; the check above already
            // confirmed this is a ready frame.
            const ready = frame as ReadyFrame
            void (async () => {
              try {
                if (ready.supportedProtocolVersions.includes(2)) {
                  const res = await this.request({ type: 'negotiate_protocol', id: '', protocolVersion: 2 })
                  if (!res.success) {
                    // Gate-fixes security Low finding (cycle 5): `res.error` comes straight from
                    // omp's own RPC response, the same untrusted-content surface `buildStartFailure`
                    // already redacts before it ever reaches a stopDetail/notify string.
                    throw new Error(`negotiate_protocol failed: ${res.error ? redactSecrets(res.error) : 'unknown error'}`)
                  }
                }
                // Gate-fixes Low finding (cycle 7): `cleanup()` above already tore down
                // `readyWait`/the frame and exit listeners, so a `cancelStart()` landing during
                // this `await` (protocol negotiation) had nothing left to act on and this would
                // resolve anyway, going `idle` despite the cancel. Re-checked just before
                // resolving.
                if (this.startCancelled) {
                  reject(await this.buildStartFailure('start cancelled'))
                  return
                }
                resolve()
              } catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)))
              }
            })()
          }
          this.on('frame', onFrame)
          // Gate-fixes test Low finding (cycle 4): purely defensive, not load-bearing for any
          // window that exists today -- the actual `resolveExecutable('omp')` cancel window
          // (cycle 3's Medium finding) is already closed by the synchronous re-check right
          // after that await, before this code even runs. Kept as a last-resort safety net for
          // any future await ever added between here and spawn, placed after every listener
          // above so `cancel()`'s synchronous `cleanup()` (which references `onFrame`/
          // `onExitDuringStart`/`onSpawnErrorDuringStart`) never runs before they exist.
          if (this.startCancelled) readyWait.cancel()
        })
      } finally {
        if (this.hasMarkedSpawned) {
          this.hasMarkedSpawned = false
          unmarkSpawned()
        }
        releaseStartSlot()
      }
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
    }
  }

  /** Dismisses the "Keep waiting?" prompt without affecting the ceiling (issue #512's "Keep
   * waiting" button). No-op outside an in-flight start()'s 'prompt' stage. */
  keepWaitingForReady(): void {
    this.readyWait?.keepWaiting()
  }

  /** User-cancelled an in-flight start (issue #512's "Cancel" button): fails the wait
   * immediately instead of waiting out the ceiling, including while still queued or deferring
   * for memory (`startCancelled`, checked at both those points -- `readyWait` does not exist
   * yet until the process actually spawns). Safe to call more than once or after start() has
   * already settled. */
  cancelStart(): void {
    this.startCancelled = true
    // Gate-fixes High finding (cycle 2): wakes an in-flight queue wait or memory-defer sleep
    // immediately (see acquireStartSlot()'s `signal` and deferStartIfMemoryLow()'s own sleep
    // below) instead of leaving `startCancelled` to be noticed only on the next poll.
    this.startAbortController?.abort()
    this.readyWait?.cancel()
  }

  /** Issue #512 requirement 5: waits while `isMemoryLow()` (memory.ts) says the machine is
   * under pressure, emitting `'start-memory-deferred'` so a caller can show "Waiting for
   * memory to free up...". Gives up after MEMORY_DEFER_CEILING_MS and lets the start proceed
   * regardless: a start that is merely slow is still better than one that never happens.
   * Gate-fixes Medium finding (cycle 6): only defers while `spawnedInFlight()` shows another
   * start has actually SPAWNED a process (not merely holding a queue slot, which cycle 5's
   * `startsInFlight()` counted -- two starts granted slots together under low memory then saw
   * each other's slot-hold as a reason to wait, with neither ever spawning to relieve the
   * pressure either was waiting for) -- re-checked every poll, not just once before the loop,
   * so this start also stops waiting the moment the other one it was behind spawns or gives up,
   * not only when it happened to already be alone from the very start. A solo start under low
   * memory (the common case: the queue already limits concurrency to `MAX_CONCURRENT_STARTS`)
   * has nothing to wait behind, so imposing up to 60s on every ordinary start under low memory
   * was pure cost with no benefit.
   * Gate-fixes High finding (cycle 5): skipped entirely when `deferForMemory: false` (the
   * readiness/login-provider probes), which must never pay this cost against their own short
   * `startDeadlineMs`. */
  private async deferStartIfMemoryLow(): Promise<void> {
    if (this.opts.deferForMemory === false) return
    const startedAt = Date.now()
    const signal = this.startAbortController?.signal
    while (isMemoryLow() && spawnedInFlight() >= 1 && !this.startCancelled && Date.now() - startedAt < MEMORY_DEFER_CEILING_MS) {
      this.emit('start-memory-deferred', { elapsedMs: Date.now() - startedAt })
      await this.abortableSleep(MEMORY_DEFER_POLL_MS, signal)
    }
  }

  /** Gate-fixes Low finding (cycle 2): a plain `setTimeout` sleep only noticed a cancel on its
   * next tick, so `deferStartIfMemoryLow`'s poll could sit on an already-cancelled start for up
   * to MEMORY_DEFER_POLL_MS. Resolves early the instant `signal` aborts instead.
   * Executor form (not `Promise.withResolvers()`): see acquireStartSlot() in startQueue.ts for
   * why -- same tsconfig.node.json `lib: ["ES2023"]` constraint. */
  private abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve()
        return
      }
      const onAbort = (): void => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Writes one JSON object to stdin as a newline-delimited frame. */
  write(obj: object): void {
    if (!this.child) {
      throw new Error('OmpProcess: start() must be called before write()')
    }
    this.child.stdin.write(JSON.stringify(obj) + '\n')
  }

  /** Sends `cmd` with a fresh unique id and resolves on the matching `response` frame. */
  async request(cmd: RpcCommand, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<ResponseFrame> {
    if (!this.child) {
      throw new Error('OmpProcess: start() must be called before request()')
    }
    if (this.exited) {
      throw new Error('OmpProcess: process has exited')
    }
    const id = `refract-${++this.requestCounter}`
    const withId: RpcCommand = { ...cmd, id }

    // Executor form: see start() for why Promise.withResolvers() isn't available here.
    return new Promise<ResponseFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`OmpProcess: request timed out after ${timeoutMs}ms (${cmd.type})`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write(withId)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** Idempotent: stdin close, wait up to 10s, then force-kill via taskkill. */
  async stop(): Promise<void> {
    this.requested = true
    if (!this.stopPromise) {
      this.stopPromise = this.doStop()
    }
    return this.stopPromise
  }

  private async doStop(): Promise<void> {
    if (!this.child || this.exited) return
    try {
      this.child.stdin.end()
    } catch (err) {
      console.error('OmpProcess: stdin.end() failed', err)
    }
    const exited = await this.waitForExit(STOP_GRACE_MS)
    if (!exited) {
      await this.hardKill()
    }
  }

  private async hardKill(): Promise<void> {
    const pid = this.child?.pid
    if (pid === undefined || this.exited) return
    // Executor form: see start() for why Promise.withResolvers() isn't available here.
    await new Promise<void>((resolve) => {
      execFile(taskkillPath(), ['/PID', String(pid), '/T', '/F'], () => resolve())
    })
    // taskkill /F should be reliable; wait for the 'exit' event it triggers rather than a
    // second timeout, per contract ("resolve after exit").
    // Executor form: see start() for why Promise.withResolvers() isn't available here.
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
    // Executor form: see start() for why Promise.withResolvers() isn't available here.
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

  private onExit(code: number | null): void {
    try {
      this.exited = true
      this.chunks.clear()
      const pid = this.child?.pid
      if (typeof pid === 'number') {
        removeProcessRecord(pid).catch((err: unknown) => {
          console.error('OmpProcess: removeProcessRecord failed', err)
        })
      }
      const error = new Error('OmpProcess: omp process exited')
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(error)
      }
      this.pending.clear()

      const waiters = this.exitWaiters
      this.exitWaiters = []
      for (const waiter of waiters) waiter()

      if (!this.exitEmitted) {
        this.exitEmitted = true
        this.emit('exit', { code, requested: this.requested })
      }
    } catch (err) {
      console.error('OmpProcess: error in exit handler', err)
    }
  }

  // Issue #512 requirement 2: the renderer (ChatPane.tsx) treats the FIRST LINE of a start
  // failure's `stopDetail` as the short banner title and everything after the first `\n` as
  // collapsible "Details" text -- `reason`/`hint` below are always exactly one line, and every
  // part appended after them always starts with its own `\n`, so that split just falls out of
  // this format with no separate title field needed.
  // Gate-fixes Medium finding (cycle 6): the old `/\b(warn|error)\b/i` missed `warning`/
  // `WARNING:` (no boundary after `warn`), `TypeError`/`SyntaxError`/`ReferenceError` (no
  // boundary before `Error`), `errors`, `ENOENT`, `fatal`, `panic`, `cannot find module`, and
  // OMP's own JSON `"level":"warn"`/`"level":"error"` lines. Widened, with no leading `\b` so a
  // ...Error suffix still matches. Falls back to the last 20 unfiltered lines (rather than an
  // empty result) when nothing recognisable is found at all -- a crash that prints a bare stack
  // trace with none of these words must not silently lose its whole diagnostic.
  private filterWarnErrorLines(text: string): string {
    const warnOrError = /"level"\s*:\s*"(?:warn|error)"|(?:warn(?:ing)?|error|fatal|panic|exception|cannot|failed|ENOENT|EACCES|EPERM|timed out)/i
    const lines = text.split('\n')
    const filtered = lines.filter((line) => warnOrError.test(line))
    if (filtered.length > 0) return filtered.join('\n')
    return lines.slice(-20).join('\n')
  }

  /** Gate-fixes Low finding (cycle 7): a plain `.slice(-maxLength)` can land mid-line, showing
   * a truncated first-line fragment in the message -- the same mid-line-cut problem
   * `ompLogTail.ts`'s `readTail` already guards against for its own raw file read. Drops that
   * leading partial line too, whenever the slice actually shortened the text. */
  private capTailLines(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text
    const sliced = text.slice(-maxLength)
    const newlineIndex = sliced.indexOf('\n')
    return newlineIndex === -1 ? '' : sliced.slice(newlineIndex + 1)
  }

  private async buildStartFailure(reason: string, ErrorClass: new (message: string) => Error = Error): Promise<Error> {
    // Gate-fixes security Medium finding (cycle 5, widened cycle 6): replaces this machine's
    // home directory with `~` in both tails (and `reason`) before redaction -- `redactSecrets`
    // targets credentials, not the local username a stderr/log line incidentally embeds in a
    // path. OMP's own log is JSON, so Windows paths there carry doubled backslashes
    // (`"filePath":"C:\\\\Users\\\\stuart\\\\..."`), and forward-slash forms (`C:/Users/...`)
    // also turn up; matching only the literal `os.homedir()` string (single backslashes) missed
    // both. Built per path segment instead, joined by a separator that matches one or two
    // backslashes or a forward slash, case-insensitively.
    const homedir = os.homedir()
    const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const homedirSegments = homedir.split(/[\\/]/).filter(Boolean)
    // Gate-fixes Low finding (cycle 7): a trailing `(?![A-Za-z0-9._-])` boundary -- without it,
    // a home of `C:\Users\stu` matched the START of `C:\Users\stuart\...` too, masking it as
    // the wrong (and partial) `~art\...`.
    const homedirRe = homedirSegments.length
      ? new RegExp(`${homedirSegments.map(escapeRegex).join('(?:\\\\{1,2}|/)')}(?![A-Za-z0-9._-])`, 'gi')
      : undefined
    const redactHome = (text: string): string => (homedirRe ? text.replace(homedirRe, '~') : text)
    // Gate-fixes security Low finding (cycle 6): `reason` (e.g. a spawn error's full omp path,
    // "process failed to spawn: ...") used to skip both this masking and `redactSecrets` below,
    // even though it becomes the banner's own title -- the first thing shown and copied.
    const redactedReason = redactSecrets(redactHome(reason))
    // Gate-fixes Medium/Low findings (cycle 2): redact BEFORE the final slice, not after -- a
    // cut landing between "Bearer " and its token used to leave the token exposed with no
    // prefix left for the pattern to match. Also drop a truncated tail's own leading partial
    // line first (`stderrTruncated`, set by `onStderrData`'s sliding window): that fragment can
    // carry a credential's tail end with no recognisable prefix of its own.
    // Gate-fixes security Low finding (cycle 6): redacts BEFORE filtering to warn/error lines
    // now (previously the other way round) -- a multi-line PEM private-key block's own `-----
    // BEGIN-----`/`-----END-----` markers often land on DIFFERENT lines than the "error:"/
    // "warn:" wording that keeps a line through the filter, so filtering first could drop the
    // `-----END-----` line before redaction ever saw it, leaving the unterminated-block pattern
    // to swallow every line after it. Redacting the whole (still multi-line) text first means
    // the PEM pattern sees the real `-----END-----` marker and only ever consumes its own block.
    const stderrForRedaction = this.stderrTruncated ? this.stderrTail.replace(/^[^\n]*\n?/, '') : this.stderrTail
    const stderrRedacted = redactSecrets(redactHome(stderrForRedaction))
    const tail = this.capTailLines(this.filterWarnErrorLines(stderrRedacted), STDERR_FAILURE_TAIL_BYTES)
    const hint = this.lastSpawnError?.code === 'ENOENT' ? ' (omp not found on PATH; set ompPath)' : ''
    const stderrPart = tail ? `\n--- stderr warnings/errors ---\n${tail}` : ''
    const pid = this.child?.pid
    const spawnedAtMs = this.spawnedAtMs
    // Issue #512 requirement 2: OMP logs to its own per-process file, not stderr, so the
    // stderr tail alone rarely explains a slow or failed start; read that pid's own log tail.
    // `spawnedAtMs` guards against a reused pid's older log being misattributed to this start.
    // Gate-fixes Medium finding (cycle 6): reads a much larger raw window than the old 4 KiB --
    // OMP's debug JSON lines run a few hundred bytes each, so 4 KiB of raw log often held only
    // 8-15 lines, routinely pushing the real warning/error out before the filter ever saw it.
    // The final message is still capped at `OMP_LOG_TAIL_BYTES` below, AFTER filtering.
    const ompLogTailRaw =
      typeof pid === 'number' && spawnedAtMs !== undefined
        ? await tailOmpLogForPid(pid, OMP_LOG_READ_WINDOW_BYTES, spawnedAtMs).catch(() => undefined)
        : undefined
    const ompLogRedacted = ompLogTailRaw !== undefined ? redactSecrets(redactHome(ompLogTailRaw)) : undefined
    const ompLogTail = ompLogRedacted !== undefined ? this.capTailLines(this.filterWarnErrorLines(ompLogRedacted), OMP_LOG_TAIL_BYTES) : undefined
    const ompLogPart = ompLogTail ? `\n--- omp log warnings/errors (pid ${pid}) ---\n${ompLogTail}` : ''
    // Gate-fixes Medium finding (cycle 5): a slow/failed start under low memory otherwise gives
    // no hint that memory pressure was ever a factor -- neither tail necessarily mentions it.
    const memoryPart = `\n--- memory ---\n${Math.round(os.freemem() / (1024 * 1024))} MB free of ${Math.round(os.totalmem() / (1024 * 1024))} MB total`
    return new ErrorClass(`OmpProcess: ${redactedReason}${hint}${stderrPart}${ompLogPart}${memoryPart}`)
  }

  private onStdoutData(chunk: Buffer): void {
    try {
      this.stdoutBuf = Buffer.concat([this.stdoutBuf, chunk])
      let newlineIndex: number
      while ((newlineIndex = this.stdoutBuf.indexOf(0x0a)) >= 0) {
        const lineBuf = this.stdoutBuf.subarray(0, newlineIndex)
        this.stdoutBuf = this.stdoutBuf.subarray(newlineIndex + 1)
        const line = lineBuf.toString('utf8').trim()
        if (!line) continue
        this.handleLine(line)
      }
    } catch (err) {
      console.error('OmpProcess: error processing stdout', err)
    }
  }

  private onStderrData(chunk: Buffer): void {
    this.stderrBuf = Buffer.concat([this.stderrBuf, chunk])
    if (this.stderrBuf.length > STDERR_TAIL_BYTES) {
      this.stderrBuf = this.stderrBuf.subarray(this.stderrBuf.length - STDERR_TAIL_BYTES)
      this.stderrTruncated = true
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      console.error('OmpProcess: skipping unparseable stdout line', err, line.slice(0, 200))
      return
    }
    this.handleParsed(parsed)
  }

  private handleParsed(parsed: unknown): void {
    if (typeof parsed !== 'object' || parsed === null || !('type' in parsed) || typeof parsed.type !== 'string') {
      console.error('OmpProcess: skipping malformed frame (no string type)', parsed)
      return
    }
    // `parsed` is now known to have a string `type` field, but TS can't connect that
    // shape to the Frame union (UnknownFrame's index signature would otherwise swallow
    // every property access below).
    const frame = parsed as Frame
    if (frame.type === 'rpc_chunk') {
      // Same reason as above: `type` narrowing alone can't isolate RpcChunkFrame here.
      const chunkFrame = frame as RpcChunkFrame
      this.handleChunk(chunkFrame)
      return
    }
    this.dispatchFrame(frame)
  }

  private dispatchFrame(frame: Frame): void {
    if (frame.type === 'response') {
      // Same reason as handleParsed: `type` narrowing alone can't isolate ResponseFrame.
      const responseFrame = frame as ResponseFrame
      const entry = this.pending.get(responseFrame.id)
      if (entry) {
        this.pending.delete(responseFrame.id)
        clearTimeout(entry.timer)
        entry.resolve(responseFrame)
      }
      // Responses are consumed by request() only; they are never emitted as 'frame'.
      return
    }
    this.emit('frame', frame)
  }

  // rpc_chunk reassembly (FINDINGS C22b / contracts/omp-usage.md "Failure handling"):
  // validates chunkId/index/count/byteLength, rejects interleaved or duplicate
  // sequences, enforces the 64 MiB reassembled ceiling, and decodes strictly as UTF-8.
  // Any failure drops the whole in-flight assembly and logs, same as an unparseable line.
  private handleChunk(frame: RpcChunkFrame): void {
    try {
      const { chunkId, index, count, byteLength, data } = frame
      if (typeof chunkId !== 'string' || chunkId.length === 0) {
        throw new Error('rpc_chunk missing chunkId')
      }
      if (!Number.isInteger(count) || count <= 0) {
        throw new Error(`rpc_chunk ${chunkId}: invalid count ${count}`)
      }
      if (!Number.isInteger(index) || index < 0 || index >= count) {
        throw new Error(`rpc_chunk ${chunkId}: invalid index ${index} for count ${count}`)
      }
      if (!Number.isInteger(byteLength) || byteLength < 0) {
        throw new Error(`rpc_chunk ${chunkId}: invalid byteLength ${byteLength}`)
      }
      if (byteLength > MAX_REASSEMBLED_BYTES) {
        throw new Error(`rpc_chunk ${chunkId}: byteLength ${byteLength} exceeds ${MAX_REASSEMBLED_BYTES} byte ceiling`)
      }
      if (typeof data !== 'string') {
        throw new Error(`rpc_chunk ${chunkId}: missing data`)
      }

      let assembly = this.chunks.get(chunkId)
      if (!assembly) {
        assembly = { parts: new Array<Buffer | undefined>(count), got: 0, byteLength }
        this.chunks.set(chunkId, assembly)
      } else if (assembly.parts.length !== count || assembly.byteLength !== byteLength) {
        this.chunks.delete(chunkId)
        throw new Error(`rpc_chunk ${chunkId}: interleaved sequence (count/byteLength changed mid-assembly)`)
      }
      if (assembly.parts[index] !== undefined) {
        this.chunks.delete(chunkId)
        throw new Error(`rpc_chunk ${chunkId}: duplicate index ${index} (interleaved sequence)`)
      }

      assembly.parts[index] = Buffer.from(data, 'base64')
      assembly.got += 1
      if (assembly.got < assembly.parts.length) return

      this.chunks.delete(chunkId)
      const parts: Buffer[] = assembly.parts.map((part, i) => {
        if (!part) throw new Error(`rpc_chunk ${chunkId}: missing part ${i} after completion`)
        return part
      })
      const whole = Buffer.concat(parts)
      if (whole.length !== assembly.byteLength) {
        throw new Error(`rpc_chunk ${chunkId}: got ${whole.length} bytes, expected ${assembly.byteLength}`)
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(whole)
      this.handleParsed(JSON.parse(text) as unknown)
    } catch (err) {
      console.error('OmpProcess: dropping malformed rpc_chunk', err)
      // The chunk's own id has no visible tie to any pending request's id (the real response,
      // with its id, only exists once reassembly succeeds), so which in-flight request this
      // corrupted assembly belonged to is unknowable here. A chunked payload is always some
      // response, so failing every currently pending request now is far better than letting the
      // real one hang silently until its own timeout.
      const reason = err instanceof Error ? err.message : String(err)
      const rejection = new Error(`OmpProcess: request failed: a chunked response failed reassembly (${reason})`)
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(rejection)
      }
      this.pending.clear()
    }
  }
}
