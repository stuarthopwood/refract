import { useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { SessionScrollState } from '@/state/scroll-store'

/** Px from the true bottom that still counts as "at the end"; absorbs sub-pixel rounding and placeholder-height settle. (#485) */
export const SCROLL_END_TOLERANCE_PX = 48

/** Consecutive frames `scrollHeight` must stay unchanged before the landing effect stops re-asserting `scrollTop`. */
export const SCROLL_LANDING_STABLE_FRAMES = 2

/** Frame cap for the landing poll; generous because a long transcript's rows settle slowly and scroll anchoring keeps nudging `scrollTop`. (#485) */
export const SCROLL_LANDING_MAX_FRAMES = 90

/** Px `scrollTop` may read back from the assigned value and still count as stuck; fractional DPR rounds sub-pixel. */
export const SCROLL_PERTURBATION_TOLERANCE_PX = 1

export interface ViewportMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** True when `metrics` is within `tolerance` px of the true bottom. */
export function isAtScrollEnd(metrics: ViewportMetrics, tolerance: number = SCROLL_END_TOLERANCE_PX): boolean {
  const distanceFromEnd = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight
  return distanceFromEnd <= tolerance
}

/** The `scrollTop` to land on: the end when there is no memory or it was at the end, else the saved offset; clamped like the browser so read-backs compare equal. */
export function resolveLandingScrollTop(
  memory: SessionScrollState | undefined,
  scrollHeight: number,
  clientHeight: number
): number {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight)
  if (!memory || memory.atEnd) return maxScrollTop
  return Math.min(memory.scrollTop, maxScrollTop)
}

/** Keeps a landed target pinned while something else (a streaming turn) keeps changing the content under it. */
export interface ScrollHold {
  /** Checked each frame after the first settle; the hold ends the first time this is false. */
  active: () => boolean
  /** Called on each held frame in which `scrollHeight` grew. */
  onGrow: () => void
  /** Called once when `active` turns false; the caller releases what the hold kept claimed. Never after an interrupt. */
  onEnded: () => void
}

export interface ScrollSettleLoopCallbacks {
  /** Computes each frame's target `scrollTop` from fresh viewport metrics. */
  computeTarget: (metrics: ViewportMetrics) => number
  /** Called once when the loop settles (stable height and on-target, or max frames); never after an interrupt. `holding` is true when the loop keeps running as a hold. */
  onSettled: (landedAtEnd: boolean, holding: boolean) => void
  /** Called once if real user input on `root` takes over before the loop settles, or during a hold. */
  onInterrupted: (atEnd: boolean) => void
  /** Checked at the start of each frame; true stops the loop without a write and calls `onAborted`. */
  shouldAbort?: () => boolean
  /** Called once if `shouldAbort` fires; a caller supplying `shouldAbort` must release its in-progress state here or follow-bottom stays dead. (#1008) */
  onAborted: () => void
  /** After a settle away from the end, keep re-asserting the target until user input, a cancel or `hold.active()` turning false. (#1021) */
  hold?: ScrollHold
}

/** Polls via `requestAnimationFrame`, re-applying a computed `scrollTop` until it settles or the user takes over; returns a silent `cancel()`. */
export function runScrollSettleLoop(root: HTMLElement, viewport: HTMLElement, callbacks: ScrollSettleLoopCallbacks): () => void {
  let cancelled = false
  let frame = 0
  let stableFrames = 0
  let lastHeight = -1
  let lastAssignedScrollTop = -1
  let holding = false

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
    const hold = callbacks.hold
    if (holding && hold) {
      if (!hold.active()) {
        cancelled = true
        removeInputListeners()
        hold.onEnded()
        return
      }
      if (scrollHeight > lastHeight) hold.onGrow()
      lastHeight = scrollHeight
      viewport.scrollTop = callbacks.computeTarget({ scrollTop: viewport.scrollTop, scrollHeight, clientHeight })
      requestAnimationFrame(step)
      return
    }
    const heightStable = scrollHeight === lastHeight
    const notPerturbed = lastAssignedScrollTop === -1 || Math.abs(viewport.scrollTop - lastAssignedScrollTop) < SCROLL_PERTURBATION_TOLERANCE_PX
    stableFrames = heightStable && notPerturbed ? stableFrames + 1 : 0
    lastHeight = scrollHeight
    frame += 1
    const target = callbacks.computeTarget({ scrollTop: viewport.scrollTop, scrollHeight, clientHeight })
    viewport.scrollTop = target
    lastAssignedScrollTop = target
    if (stableFrames >= SCROLL_LANDING_STABLE_FRAMES || frame >= SCROLL_LANDING_MAX_FRAMES) {
      const landedAtEnd = isAtScrollEnd({ scrollTop: viewport.scrollTop, scrollHeight, clientHeight })
      // A landing at the end needs no hold: the follow policy already keeps the end in view.
      holding = !landedAtEnd && Boolean(callbacks.hold?.active())
      if (!holding) {
        cancelled = true
        removeInputListeners()
      }
      callbacks.onSettled(landedAtEnd, holding)
      if (!holding) return
    }
    requestAnimationFrame(step)
  }

  requestAnimationFrame(step)
  return () => {
    cancelled = true
    removeInputListeners()
  }
}

// Gesture intent uses a recency timestamp, not `isTrusted` (true for programmatic scrolls too). (#700)
const SCROLL_KEYS: Record<string, true> = { PageUp: true, PageDown: true, Home: true, End: true, ArrowUp: true, ArrowDown: true, ArrowLeft: true, ArrowRight: true, ' ': true }
const GESTURE_RECENCY_MS = 500

export function useScrollGestureTracking() {
  const lastGestureAtRef = useRef(0)
  // A scrollbar drag outlasts the recency window; tracked on `window` since the pointer can leave the element mid-drag.
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
  // A scroll key bubbling from an editable descendant is not scroll intent.
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!(event.key in SCROLL_KEYS)) return
    const target = event.target
    const isEditable = target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
    if (target !== event.currentTarget && isEditable) return
    markGesture()
  }
  const isRecentGesture = () => pointerHeldRef.current || Date.now() - lastGestureAtRef.current <= GESTURE_RECENCY_MS
  // A starting landing effect invalidates stale gestures so its own `scrollTop` write isn't read as user intent.
  const resetGesture = () => {
    lastGestureAtRef.current = 0
    pointerHeldRef.current = false
  }
  const gestureProps = { onWheel: markGesture, onPointerDown: markPointerDown, onTouchStart: markGesture, onTouchMove: markGesture, onKeyDown: handleKeyDown }
  return { isRecentGesture, resetGesture, gestureProps }
}
