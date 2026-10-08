// Process-wide start concurrency gate (issue #512 requirement 5: "start agents one or two at a
// time"). Every `OmpProcess.start()` acquires a slot before spawning, regardless of which
// Session or caller constructed it (`SessionAgent.ts`, `readiness.ts`, `loginProviders.ts`), so
// the limit holds across the whole app without any caller needing to know about it.

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

/** Issue #512 Medium finding (cycle 5): lets `OmpProcess.deferStartIfMemoryLow()` skip its
 * memory defer entirely when no other start currently holds a slot -- a solo start under low
 * memory has nothing else to wait behind; the queue slot itself is already the backpressure
 * mechanism, and deferring anyway is what made the readiness/login-providers probes (and every
 * ordinary Session start) pay a fixed cost under low memory even with a slot free. */
export function startsInFlight(): number {
  return state.inFlight
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
