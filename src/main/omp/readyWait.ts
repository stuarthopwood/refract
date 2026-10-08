// Pure staged-wait state machine for omp's start-up ready handshake (issue #512: a fixed
// 60s cutoff kills a slow-but-healthy omp start on a busy machine with no progress shown and
// no reason given). This module has no knowledge of child processes, IPC, or the DOM: it only
// tracks elapsed time against two thresholds and exposes stage/outcome events, so it can be
// driven by OmpProcess.ts and unit-tested with fake timers in isolation.
//
// Stages (requirement 1, "Starting agent… N s" / Keep waiting / Cancel):
//   'waiting'  - before the prompt threshold; no user action offered yet.
//   'prompt'   - past the prompt threshold; the caller should show elapsed time plus
//                "Keep waiting" / "Cancel" (the wait itself is unaffected: it is already
//                continuing toward the ceiling by default, same as today's behaviour, just
//                no longer silent).
//   'extended' - the user explicitly chose "Keep waiting"; same clock, dismisses the prompt.
//   'ceiling'  - the ceiling has been reached; the caller must stop waiting and fail.
//
// Outcomes (terminal, emitted exactly once):
//   'ready'     - the caller observed the real ready frame (success).
//   'cancelled' - the user chose "Cancel" (or the caller cancelled on its behalf).
//   'ceiling'   - the ceiling elapsed with no ready frame and no cancellation.

export type ReadyWaitStageKind = 'waiting' | 'prompt' | 'extended' | 'ceiling'

export interface ReadyWaitStage {
  kind: ReadyWaitStageKind
  elapsedMs: number
}

export type ReadyWaitOutcomeKind = 'ready' | 'cancelled' | 'ceiling'

export interface ReadyWaitOutcome {
  kind: ReadyWaitOutcomeKind
  elapsedMs: number
}

export interface ReadyWaitOptions {
  /** Elapsed time at which the stage moves from 'waiting' to 'prompt' (Keep waiting/Cancel
   * becomes available). Issue #512 default: 60_000 (today's old hard cutoff, now just a
   * prompt instead of a kill). */
  promptAfterMs: number
  /** Elapsed time at which the wait fails outright if nobody cancelled first. Issue #512
   * default: 180_000 ("ceiling around 180s"). */
  ceilingMs: number
  /** How often the stage re-emits with an updated `elapsedMs` so the UI's "N s" counter can
   * tick without a per-second re-render driven by the caller. Default 1_000. */
  tickMs?: number
}

type Listener<T> = (value: T) => void

const DEFAULT_TICK_MS = 1_000

/** Drives one staged wait. Call `start()` once; call `ready()`, `cancel()`, or let the
 * ceiling timer fire to reach a terminal outcome. `keepWaiting()` only has an effect while
 * the stage is 'prompt'; it is a no-op (not an error) once the wait is already extended or
 * finished, since a stale button click racing a resolve must never throw. */
export class ReadyWaitController {
  private readonly promptAfterMs: number
  private readonly ceilingMs: number
  private readonly tickMs: number
  private readonly startedAt: number
  private readonly now: () => number
  private readonly stageListeners = new Set<Listener<ReadyWaitStage>>()
  private readonly outcomeListeners = new Set<Listener<ReadyWaitOutcome>>()
  private stageKind: ReadyWaitStageKind = 'waiting'
  private tickTimer: NodeJS.Timeout | undefined
  private promptTimer: NodeJS.Timeout | undefined
  private ceilingTimer: NodeJS.Timeout | undefined
  private finished = false
  private started = false

  constructor(options: ReadyWaitOptions, now: () => number = Date.now) {
    if (!(options.promptAfterMs > 0) || !(options.ceilingMs > options.promptAfterMs)) {
      throw new Error(
        `ReadyWaitController: invalid thresholds (promptAfterMs=${options.promptAfterMs}, ceilingMs=${options.ceilingMs}); ceilingMs must exceed promptAfterMs`,
      )
    }
    this.promptAfterMs = options.promptAfterMs
    this.ceilingMs = options.ceilingMs
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS
    this.now = now
    this.startedAt = this.now()
  }

  private elapsed(): number {
    return this.now() - this.startedAt
  }

  onStage(listener: Listener<ReadyWaitStage>): () => void {
    this.stageListeners.add(listener)
    return () => this.stageListeners.delete(listener)
  }

  onOutcome(listener: Listener<ReadyWaitOutcome>): () => void {
    this.outcomeListeners.add(listener)
    return () => this.outcomeListeners.delete(listener)
  }

  /** Arms the prompt/ceiling timers and the elapsed-time ticker. Calling it more than once
   * throws (gate-fixes Low finding: a second call used to silently leak a second set of timers
   * and double every future emission) -- every caller already calls it exactly once. */
  start(): void {
    if (this.started) {
      throw new Error('ReadyWaitController: start() already called')
    }
    this.started = true
    this.emitStage()
    this.promptTimer = setTimeout(() => {
      if (this.finished) return
      this.stageKind = 'prompt'
      this.emitStage()
    }, this.promptAfterMs)
    this.ceilingTimer = setTimeout(() => {
      if (this.finished) return
      this.stageKind = 'ceiling'
      this.emitStage()
      this.finish({ kind: 'ceiling', elapsedMs: this.elapsed() })
    }, this.ceilingMs)
    this.tickTimer = setInterval(() => {
      if (this.finished) return
      this.emitStage()
    }, this.tickMs)
  }

  /** "Keep waiting": dismisses the prompt without affecting the ceiling. No-op outside the
   * 'prompt' stage (including after the wait has already finished). */
  keepWaiting(): void {
    if (this.finished || this.stageKind !== 'prompt') return
    this.stageKind = 'extended'
    this.emitStage()
  }

  /** User- or caller-initiated cancellation. No-op if already finished. */
  cancel(): void {
    if (this.finished) return
    this.finish({ kind: 'cancelled', elapsedMs: this.elapsed() })
  }

  /** The real ready frame arrived: success. No-op if already finished. */
  ready(): void {
    if (this.finished) return
    this.finish({ kind: 'ready', elapsedMs: this.elapsed() })
  }

  /** Clears all timers without emitting an outcome. Safe to call after `finish()` (already a
   * no-op then) or to abandon a wait whose caller is tearing down for an unrelated reason. */
  dispose(): void {
    clearTimeout(this.promptTimer)
    clearTimeout(this.ceilingTimer)
    clearInterval(this.tickTimer)
  }

  private finish(outcome: ReadyWaitOutcome): void {
    this.finished = true
    this.dispose()
    for (const listener of this.outcomeListeners) listener(outcome)
  }

  private emitStage(): void {
    const stage: ReadyWaitStage = { kind: this.stageKind, elapsedMs: this.elapsed() }
    for (const listener of this.stageListeners) listener(stage)
  }
}
