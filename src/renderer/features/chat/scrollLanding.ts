import { useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
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
   * stops immediately -- no `scrollTop` write -- and calls `onAborted` instead of
   * `onSettled`/`onInterrupted` (gate round 2, issue #1008 item 3: `jumpToStageRow`'s jumped-to
   * row can be removed by a Session/Conversation switch mid-loop). The session-landing effect
   * below has no such external target (`resolveLandingScrollTop` only ever reads the
   * scroll-memory store), so it never supplies this -- `shouldAbort` undefined means the loop can
   * never abort, only settle or be interrupted. */
  shouldAbort?: () => boolean
  /** Called exactly once if `shouldAbort` fires (gate round 4 fix, issue #1008, M1 -- falsified
   * live): previously `shouldAbort` stopped the loop silently, calling NEITHER `onSettled` nor
   * `onInterrupted`, so a caller's own "settle in progress" state (`landingInProgressRef`,
   * `autoScrollSuppressed` in `Transcript.tsx`) stayed stuck true forever -- `handleViewportScroll`
   * and the ResizeObserver both no-op while that ref reads true, so the "at end" state and the
   * vendored scroller's own `autoScroll` prop went dead until an unrelated Session/Conversation
   * switch happened to reset them. Every caller that supplies `shouldAbort` MUST also supply this
   * to release whatever it claimed before starting the loop; a caller with no `shouldAbort` (the
   * session-landing effect) can pass a no-op here since it is provably unreachable without one. */
  onAborted: () => void
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
 * since only THIS shared engine's caller, via `onSettled`/`onInterrupted`/`onAborted`, can reach
 * the `autoScrollSuppressed` state that holds follow-bottom off once the loop itself has settled,
 * until the user genuinely scrolls back to the end -- that flag does NOT by itself stop a jump
 * made mid-loop, on a turn that is still streaming, from being pulled back toward the end by a
 * LATER chunk's own content once this loop has already settled (issue #1021, jump-specific, not
 * fixed here). Returns a `cancel()` function the
 * caller's own effect cleanup (or early-return path) can call to stop the loop and remove its
 * input listeners without invoking any callback -- exactly what the landing effect's own cleanup
 * already did inline before this extraction. */
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
      callbacks.onAborted()
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

// Gate round 5 fix (#700 E1, Main's own correction of a round-4 `isTrusted` attempt -- true for
// EVERY browser-fired scroll, including a programmatic write or the vendored scroller's own
// corrective snap, so it filtered nothing): real user scroll-gesture intent (wheel, pointer,
// touch, or a scroll key), tracked via a recency timestamp rather than `isTrusted`, shared
// via a hook so `handleViewportScroll` can gate SET on "was this within the window" while LIFT
// on `atEnd` stays unconditional. Same detection technique PinnedTodoPanel.tsx's own
// `userScrolledRef` uses, but a recency window instead of a one-way latch: Transcript.tsx's
// suppression flips in both directions repeatedly across a session, not once per mount/expand.
const SCROLL_KEYS: Record<string, true> = { PageUp: true, PageDown: true, Home: true, End: true, ArrowUp: true, ArrowDown: true, ArrowLeft: true, ArrowRight: true, ' ': true }
const GESTURE_RECENCY_MS = 500

export function useScrollGestureTracking() {
  const lastGestureAtRef = useRef(0)
  // Gate round 6 fix (#700 F1 item 4, Main): a scrollbar drag can run far longer than
  // `GESTURE_RECENCY_MS` below -- tracked on `window`, not the viewport, since the pointer can
  // leave the element mid-drag and still be "held" from the user's own perspective.
  const pointerHeldRef = useRef(false)
  useEffect(() => {
    const onPointerUp = () => { pointerHeldRef.current = false }
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    return () => {
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    }
  }, [])
  const markGesture = () => { lastGestureAtRef.current = Date.now() }
  const markPointerDown = () => {
    pointerHeldRef.current = true
    markGesture()
  }
  // Gate round 6 fix (#700 F1 item 2, Main): a scroll key bubbling up from an editable
  // descendant (defensive -- nothing editable lives inside this viewport today) must never
  // count as scroll intent unless the viewport itself was the direct target.
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!(event.key in SCROLL_KEYS)) return
    const target = event.target
    const isEditable = target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
    if (target !== event.currentTarget && isEditable) return
    markGesture()
  }
  const isRecentGesture = () => pointerHeldRef.current || Date.now() - lastGestureAtRef.current <= GESTURE_RECENCY_MS
  // Gate round 6 fix (#700 F1 item 3, Main): a landing effect starting must invalidate any
  // stale gesture -- its own corrective `scrollTop` write must never be misread as the SET this
  // gesture would otherwise still be "recent" enough to justify.
  const resetGesture = () => {
    lastGestureAtRef.current = 0
    pointerHeldRef.current = false
  }
  const gestureProps = { onWheel: markGesture, onPointerDown: markPointerDown, onTouchStart: markGesture, onTouchMove: markGesture, onKeyDown: handleKeyDown }
  return { isRecentGesture, resetGesture, gestureProps }
}
