// Process-wide start concurrency gate (issue #512 requirement 5: "start agents one or two at a
// time"). Every Session `OmpProcess.start()` (`SessionAgent.ts`) acquires a slot before
// spawning, so the limit holds across every Session without any caller needing to know about
// it. Gate-fixes Medium finding (cycle 7): the readiness/login-provider probes (`readiness.ts`,
// `loginProviders.ts`) now opt OUT via `OmpProcessOptions.useStartQueue: false` instead -- on a
// busy machine two slow Session starts could each hold one of the queue's two slots for up to
// 180s, longer than either probe's own 60s deadline, starving a probe behind them while it was
// still queued.

const MAX_CONCURRENT_STARTS = 2

interface StartQueueState {
  maxConcurrent: number
  inFlight: number
  waiters: Array<() => void>
}

function createState(maxConcurrent: number): StartQueueState {
  return { maxConcurrent, inFlight: 0, waiters: [] }
}

let state = createState(MAX_CONCURRENT_STARTS)

function releaseWaitersIfRoom(): void {
  while (state.inFlight < state.maxConcurrent && state.waiters.length > 0) {
    const waiter = state.waiters.shift()
    if (!waiter) break
    state.inFlight += 1
    waiter()
  }
}

// Gate-fixes Medium finding (cycle 6): `startsInFlight()` (cycle 5) counted every start
// holding a queue slot, including one still deferring for memory itself -- two starts granted
// slots together under low memory each saw the OTHER's mere slot-hold as "another start is in
// flight" and both deferred the full `MEMORY_DEFER_CEILING_MS`, even though neither was actually
// spawning (consuming the memory the defer exists to wait out). Replaced with a narrower count
// of starts that have ACTUALLY spawned a child process -- the only kind of "in flight" that is
// really consuming memory and worth deferring behind.
let spawnedCount = 0

/** Call once, immediately after `spawn()` returns successfully. Paired with `unmarkSpawned()`. */
export function markSpawned(): void {
  spawnedCount += 1
}

/** Call exactly once per `markSpawned()` call, when that start's slot is released (success or
 * failure) -- idempotent in the sense that it never goes negative, but callers should still only
 * call it once per matching `markSpawned()`. */
export function unmarkSpawned(): void {
  spawnedCount = Math.max(0, spawnedCount - 1)
}

/** Lets `OmpProcess.deferStartIfMemoryLow()` skip (or stop) its memory defer once no OTHER start
 * has actually spawned a process -- a solo start under low memory (or one left alone once every
 * other start has either spawned past its own defer or given up) has nothing left to wait
 * behind; the queue slot itself is already the backpressure mechanism. Re-checked every defer
 * poll (not just once before the loop), so this start stops waiting the moment the other one it
 * was behind actually spawns or gives up -- not only when it happened to already be past that
 * point when the loop started. */
export function spawnedInFlight(): number {
  return spawnedCount
}

export interface AcquireStartSlotOptions {
  /** Called synchronously, before this call has any slot, the moment it actually has to wait
   * (gate-fixes High finding: the caller used to learn about the wait only once it was already
   * over, by resolving with a `waited: true` flag, so the "Waiting to start…" state never had
   * anything left to show). Never called when a slot is free and granted immediately. */
  onQueued?: () => void
  /** Aborts the wait (gate-fixes High finding: a `cancelStart()`/`shutdown()` that arrived while
   * still queued used to be stuck until some other Session's start released a slot, however many
   * minutes away that was). If it fires before a slot is granted, the waiter is abandoned and the
   * promise rejects. If it fires after a slot was already granted, the slot is released
   * immediately instead, so a caller that reacted to the same signal elsewhere doesn't have to
   * also notice and release it. */
  signal?: AbortSignal
}

/** Resolves with a release function once a start slot is available (immediately if under the
 * limit), or rejects if `options.signal` aborts before one is granted. The release function is
 * idempotent: a second call (whether from a caller's own `finally` or from the abort-after-grant
 * path above) never double-decrements `inFlight` and admits one too many concurrent starts.
 * Executor form (not `Promise.withResolvers()`): `acquireStartSlot` needs a `reject` reachable
 * from the `onAbort` listener registered below resolve/reject are both created, which
 * `withResolvers()` would give just as well, but tsconfig.node.json pins `lib` to `ES2023`
 * (owned by another task; see OmpProcess.ts's own note), so `Promise.withResolvers` is not in
 * scope here either. */
export function acquireStartSlot(options: AcquireStartSlotOptions = {}): Promise<() => void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let released = false
    const doRelease = (): void => {
      if (released) return
      released = true
      release()
    }
    const grant = (): void => {
      settled = true
      resolve(doRelease)
    }

    let waiterEntry: (() => void) | undefined
    const onAbort = (): void => {
      if (settled) {
        doRelease()
        return
      }
      settled = true
      if (waiterEntry) {
        const index = state.waiters.indexOf(waiterEntry)
        if (index !== -1) state.waiters.splice(index, 1)
      }
      reject(new Error('OmpProcess: start cancelled'))
    }

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    if (state.inFlight < state.maxConcurrent) {
      state.inFlight += 1
      grant()
      return
    }
    // Gate-fixes Low finding (cycle 3): pushed BEFORE `onQueued()` runs, not after. A listener
    // that aborts its own signal synchronously (none do today; this is a latent-leak guard) used
    // to find no waiter yet to splice out, so `onAbort` would reject while the waiter it never
    // saw stayed queued -- granted later, it would take a slot nothing would ever release.
    waiterEntry = () => grant()
    state.waiters.push(waiterEntry)
    options.onQueued?.()
  })
}

function release(): void {
  state.inFlight = Math.max(0, state.inFlight - 1)
  releaseWaitersIfRoom()
}
