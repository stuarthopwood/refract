import { isAtScrollEnd } from './scrollLanding'
import type { SessionScrollState } from '@/state/scroll-store'

/** What the transcript's follow-the-end policy exposes to the view. `suppressed` is the inverse of the scroller's `autoScroll`. */
export interface FollowState {
  suppressed: boolean
  isAtEnd: boolean
  /** Content grew after the user detached; the Scroll to end button shows a dot until they re-attach. */
  newContent: boolean
}

/** A Scroll to end across more than this many viewport heights jumps at once; a glide that long would just be motion. */
export const SMOOTH_SCROLL_MAX_VIEWPORTS = 2

/** The slice of the scroll viewport the policy reads and writes; a plain object stands in for it in tests. */
export interface FollowViewport {
  scrollTop: number
  scrollTo?: (options: { top: number; behavior: 'smooth' }) => void
  readonly scrollHeight: number
  readonly clientHeight: number
}

export interface FollowDeps {
  getViewport: () => FollowViewport | null
  /** True while a landing or jump loop owns `scrollTop`; scroll and resize events are then not user intent. */
  isLanding: () => boolean
  isRecentGesture: () => boolean
  record: (state: SessionScrollState) => void
  prefersReducedMotion: () => boolean
  onChange: (state: FollowState) => void
}

export interface ScrollFollow {
  getState: () => FollowState
  /** Replaces part of the state and notifies. */
  setState: (next: Partial<FollowState>) => void
  handleScroll: () => void
  handleResize: () => void
  scrollToEnd: () => void
  /** Records the current height as seen, so growth that happened while a landing or jump owned the view is not read as new content. */
  syncHeight: () => void
  /** Forgets the last height: the next resize only seeds it. Used when a different Session's content takes the viewport. */
  resetHeight: () => void
}

/** Detach, re-attach and end-follow policy for one `Transcript`, kept free of React so a fake viewport can drive it. (#459) */
export function createScrollFollow(deps: FollowDeps): ScrollFollow {
  let state: FollowState = { suppressed: false, isAtEnd: true, newContent: false }
  let lastScrollTop = 0
  let lastScrollHeight = -1
  let smoothTarget: number | null = null

  const setState = (next: Partial<FollowState>) => {
    const merged = { ...state, ...next }
    if (merged.suppressed === state.suppressed && merged.isAtEnd === state.isAtEnd && merged.newContent === state.newContent) return
    state = merged
    deps.onChange(state)
  }

  const atEndOf = (viewport: FollowViewport) =>
    isAtScrollEnd({ scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight })

  function handleScroll() {
    const viewport = deps.getViewport()
    if (!viewport || deps.isLanding()) return
    // Mid-animation positions are not the user's: keep the button hidden until the glide arrives or the user takes over.
    if (smoothTarget !== null) {
      if (!deps.isRecentGesture() && !atEndOf(viewport)) return
      smoothTarget = null
    }
    const atEnd = atEndOf(viewport)
    deps.record({ atEnd, scrollTop: viewport.scrollTop })
    const movedUp = viewport.scrollTop < lastScrollTop
    lastScrollTop = viewport.scrollTop
    const detach = atEnd !== !state.suppressed && (atEnd || (movedUp && deps.isRecentGesture()))
    const suppressed = detach ? !atEnd : state.suppressed
    setState({ suppressed, isAtEnd: atEnd, newContent: suppressed ? state.newContent : false })
  }

  // The library follows streamed text itself but not a height change nothing streamed (Shiki swap, Mermaid,
  // tool-group merge) or a viewport resize, so an attached transcript re-pins here. (#459)
  function handleResize() {
    const viewport = deps.getViewport()
    if (!viewport || deps.isLanding()) return
    const grew = lastScrollHeight >= 0 && viewport.scrollHeight > lastScrollHeight
    lastScrollHeight = viewport.scrollHeight
    if (!state.suppressed) {
      smoothTarget = null
      viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
      lastScrollTop = viewport.scrollTop
      setState({ isAtEnd: true, newContent: false })
      return
    }
    // A click that expands a row is the user's own growth, not new content arriving.
    const arrived = grew && !deps.isRecentGesture()
    setState({ isAtEnd: atEndOf(viewport), newContent: state.newContent || arrived })
  }

  function scrollToEnd() {
    const viewport = deps.getViewport()
    if (!viewport) return
    const target = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    const smooth = viewport.scrollTo && !deps.prefersReducedMotion() && target - viewport.scrollTop <= viewport.clientHeight * SMOOTH_SCROLL_MAX_VIEWPORTS
    if (smooth) {
      smoothTarget = target
      viewport.scrollTo?.({ top: target, behavior: 'smooth' })
    } else {
      smoothTarget = null
      viewport.scrollTop = target
      lastScrollTop = target
    }
    deps.record({ atEnd: true, scrollTop: target })
    setState({ suppressed: false, isAtEnd: true, newContent: false })
  }

  function syncHeight() {
    const viewport = deps.getViewport()
    if (viewport) lastScrollHeight = viewport.scrollHeight
  }

  function resetHeight() {
    lastScrollHeight = -1
  }

  return { getState: () => state, setState, handleScroll, handleResize, scrollToEnd, syncHeight, resetHeight }
}

/** True when the newest item is a user message that was not there before: a send always follows. (#459) */
export function isNewSend(previous: readonly { kind: string; id: string }[], next: readonly { kind: string; id: string }[]): boolean {
  const last = next[next.length - 1]
  if (!last || last.kind !== 'user') return false
  return !previous.some((item) => item.id === last.id)
}
