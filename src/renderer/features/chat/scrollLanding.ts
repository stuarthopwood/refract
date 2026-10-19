import type { SessionScrollState } from '@/state/scroll-store'

/** Issue #485: how far (in px) from the true bottom still counts as "at the end" when recording
 * or restoring a Session's scroll position -- a little slack absorbs sub-pixel rounding and a
 * `content-visibility:auto` row's placeholder-to-real height settle, without miscounting a
 * developer who is genuinely reading a few rows up as "at the end". */
export const SCROLL_END_TOLERANCE_PX = 48

/** How many consecutive animation frames the just-applied content's `scrollHeight` must stay
 * unchanged before the landing effect stops re-asserting the target `scrollTop` (a
 * `content-visibility:auto` row settling from its placeholder height to its real one can still be
 * in flight right after commit). */
export const SCROLL_LANDING_STABLE_FRAMES = 2

/** Upper bound on animation frames the landing effect polls for, so a layout that never truly
 * settles cannot poll forever. Generous on purpose (issue #485 gate fix): a long transcript (many
 * `content-visibility:auto` rows) can take well over `SCROLL_LANDING_STABLE_FRAMES`' worth of
 * frames for every row above the landing target to finish promoting from its placeholder height,
 * and until that is done either Chromium's own scroll anchoring or (while still catching up)
 * `MessageScrollerProvider`'s own follow-bottom behaviour can keep nudging `scrollTop` away from
 * the target for longer than a short bound would tolerate -- Transcript.tsx's perturbation check
 * resets the stable-frame counter on every such nudge, so a generous ceiling here is what actually
 * gives a big transcript enough time to land correctly instead of giving up early. */
export const SCROLL_LANDING_MAX_FRAMES = 90

/** Gate fixes 2 (finding 3): how far (in px) `viewport.scrollTop` may read back from the value
 * the landing loop just assigned it and still count as "stuck" (`notPerturbed`, Transcript.tsx).
 * At a fractional device pixel ratio (125%/150% Windows scaling) the browser can report back a
 * `scrollTop` that differs from the assigned value by a sub-pixel rounding amount; strict `===`
 * then never matches, `notPerturbed` is never true, and an at-end landing spends its entire
 * `SCROLL_LANDING_MAX_FRAMES` budget fighting a gap that was never really there (the same shape
 * of bug the `resolveLandingScrollTop` clamp above already fixed for the unclamped-target case). */
export const SCROLL_PERTURBATION_TOLERANCE_PX = 1

export interface ViewportMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** Pure so the decision is unit-testable without a DOM: true when `metrics` is within
 * `tolerance` px of the true bottom. */
export function isAtScrollEnd(metrics: ViewportMetrics, tolerance: number = SCROLL_END_TOLERANCE_PX): boolean {
  const distanceFromEnd = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight
  return distanceFromEnd <= tolerance
}

/** The `scrollTop` to land a (re)applied Session/Conversation view on (issue #485): the end when
 * there is no memory yet (a never-visited Session, or a Session whose Conversation just changed,
 * `useChatScrollStore`'s `clear`) or the memory says the developer left at the end, otherwise the
 * exact offset they left at. Clamped to `scrollHeight - clientHeight` (never negative) -- the
 * same clamp the browser itself applies to `scrollTop` -- so the caller's own "did my last
 * assignment stick" check can actually compare like with like (quality-gate cycle 2, finding 1):
 * an unclamped "land at end" target of plain `scrollHeight` can never equal the browser-clamped
 * `viewport.scrollTop` read back afterwards, so every at-end landing silently spent its entire
 * settle budget fighting a gap that was never there. */
export function resolveLandingScrollTop(
  memory: SessionScrollState | undefined,
  scrollHeight: number,
  clientHeight: number
): number {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight)
  if (!memory || memory.atEnd) return maxScrollTop
  return Math.min(memory.scrollTop, maxScrollTop)
}

export interface ScrollSettleLoopCallbacks {
  /** Called once per animation frame with the viewport's own CURRENT metrics (read fresh, not
   * memoised) to compute that frame's target `scrollTop`. */
  computeTarget: (metrics: ViewportMetrics) => number
  /** Called exactly once, when the loop decides it has settled -- `scrollHeight` unchanged AND
   * the viewport on-target for `SCROLL_LANDING_STABLE_FRAMES` consecutive frames, or
   * `SCROLL_LANDING_MAX_FRAMES` reached -- never if a real user input interrupts it first. */
  onSettled: (landedAtEnd: boolean) => void
  /** Called exactly once if a real wheel/key/pointer/touch/focusin event on `root` fires before
   * the loop naturally settles -- the developer has taken over mid-settle. */
  onInterrupted: (atEnd: boolean) => void
  /** Checked at the START of every frame, before `computeTarget`; if it returns true the loop
   * stops immediately -- no `scrollTop` write, no `onSettled`/`onInterrupted` call -- the
   * caller's own target has disappeared out from under it (gate round 2, issue #1008 item 3:
   * `jumpToStageRow`'s jumped-to row can be removed by a Session/Conversation switch mid-loop;
   * the caller already handles its own cleanup for that, this just stops writing to a viewport
   * that may itself be gone too). The session-landing effect below has no such external target
   * (`resolveLandingScrollTop` only ever reads the scroll-memory store), so it never supplies
   * this. */
  shouldAbort?: () => boolean
}

/** Gate round 2 (issue #1008, falsified live): the shared "poll via `requestAnimationFrame`,
 * re-applying a freshly-computed target `scrollTop` every frame, stop on real user input" engine
 * `Transcript.tsx`'s own session-landing effect already proved against `content-visibility:auto`
 * row growth, Chromium's own scroll anchoring, AND `MessageScrollerProvider`'s own sticky
 * follow-bottom mode (this file's own `SCROLL_LANDING_MAX_FRAMES` doc already names that last one
 * explicitly) -- extracted here so `jumpToStageRow` (`Transcript.tsx`) can reuse the EXACT same
 * engine for a one-shot "jump to this Stage row" instead of re-solving the same fight with a
 * second, narrower implementation (the deleted `stageJump.ts#settleScrollToRow`, which only ever
 * held the line for its own short, fixed frame budget -- the instant that budget ran out, nothing
 * stopped the vendored scroller's follow-bottom mode re-engaging on the NEXT streamed chunk,
 * since only THIS shared engine's caller, via `onSettled`/`onInterrupted`, can reach the
 * `autoScrollSuppressed` state that actually holds it off). Returns a `cancel()` function the
 * caller's own effect cleanup (or early-return path) can call to stop the loop and remove its
 * input listeners without invoking either callback -- exactly what the landing effect's own
 * cleanup already did inline before this extraction. */
export function runScrollSettleLoop(root: HTMLElement, viewport: HTMLElement, callbacks: ScrollSettleLoopCallbacks): () => void {
  let cancelled = false
  let frame = 0
  let stableFrames = 0
  let lastHeight = -1
  let lastAssignedScrollTop = -1

  function removeInputListeners() {
    root.removeEventListener('wheel', handleViewportPointerOrWheel)
    root.removeEventListener('keydown', handleKeyInput)
    root.removeEventListener('pointerdown', handleViewportPointerOrWheel)
    root.removeEventListener('touchstart', handleViewportPointerOrWheel)
    root.removeEventListener('focusin', handleFocusInput)
  }

  function handleUserInput() {
    if (cancelled) return
    cancelled = true
    removeInputListeners()
    const atEnd = isAtScrollEnd({ scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight })
    callbacks.onInterrupted(atEnd)
  }

  const SCROLL_NAVIGATION_KEYS: Record<string, true> = {
    ArrowUp: true, ArrowDown: true, Home: true, End: true, PageUp: true, PageDown: true, ' ': true
  }
  function handleKeyInput(event: KeyboardEvent) {
    if (!SCROLL_NAVIGATION_KEYS[event.key]) return
    handleUserInput()
  }

  function handleFocusInput(event: FocusEvent) {
    if (!viewport.contains(event.target as Node)) return
    handleUserInput()
  }

  function handleViewportPointerOrWheel(event: Event) {
    if (!(event.target instanceof Node) || !viewport.contains(event.target)) return
    handleUserInput()
  }

  root.addEventListener('wheel', handleViewportPointerOrWheel, { passive: true })
  root.addEventListener('keydown', handleKeyInput, { passive: true })
  root.addEventListener('pointerdown', handleViewportPointerOrWheel, { passive: true })
  root.addEventListener('touchstart', handleViewportPointerOrWheel, { passive: true })
  root.addEventListener('focusin', handleFocusInput, { passive: true })

  function step() {
    if (cancelled) return
    if (callbacks.shouldAbort?.()) {
      cancelled = true
      removeInputListeners()
      return
    }
    const { scrollHeight, clientHeight } = viewport
    const heightStable = scrollHeight === lastHeight
    const notPerturbed = lastAssignedScrollTop === -1 || Math.abs(viewport.scrollTop - lastAssignedScrollTop) < SCROLL_PERTURBATION_TOLERANCE_PX
    stableFrames = heightStable && notPerturbed ? stableFrames + 1 : 0
    lastHeight = scrollHeight
    frame += 1
    const target = callbacks.computeTarget({ scrollTop: viewport.scrollTop, scrollHeight, clientHeight })
    viewport.scrollTop = target
    lastAssignedScrollTop = target
    if (stableFrames >= SCROLL_LANDING_STABLE_FRAMES || frame >= SCROLL_LANDING_MAX_FRAMES) {
      cancelled = true
      removeInputListeners()
      const landedAtEnd = isAtScrollEnd({ scrollTop: viewport.scrollTop, scrollHeight, clientHeight })
      callbacks.onSettled(landedAtEnd)
      return
    }
    requestAnimationFrame(step)
  }

  requestAnimationFrame(step)
  return () => {
    cancelled = true
    removeInputListeners()
  }
}
