import type { SessionScrollState } from '@/state/scroll-store'
import type { JumpControl } from '../chat-nav/rowJumpLoop'
import { createScrollFollow, isNewSend, type FollowDeps, type ScrollFollow } from './scrollFollow'

export interface TranscriptScrollDeps {
  getViewport: FollowDeps['getViewport']
  isRecentGesture: FollowDeps['isRecentGesture']
  resetGesture: () => void
  record: FollowDeps['record']
  prefersReducedMotion: FollowDeps['prefersReducedMotion']
  onChange: FollowDeps['onChange']
  /** Read live: a memoised jump callback must not see a stale running state. (#1021) */
  isTurnRunning: () => boolean
}

type Sendable = readonly { kind: string; id: string }[]

export interface TranscriptScroll {
  follow: ScrollFollow
  /** What a landing or jump loop claims and releases; shared with the nav bridge. */
  jumpControl: JumpControl
  /** True while a landing or jump loop owns `scrollTop`. */
  landingRef: { current: boolean }
  /** Scroll to end: ends any jump hold, then follows the end again. */
  scrollToEnd: () => void
  /** A different Session's (or generation's) content takes the viewport: claim it until the landing settles. */
  beginLanding: (memory: SessionScrollState | undefined) => void
  /** Called with the items after every change; a new send ends a hold and follows. Skipped across a landing-key change so the saved position wins. (#459) */
  noteItems: (landingKey: string, items: Sendable) => void
}

/** The scroll state one `Transcript` shares between its follow policy, landing loop and jump loops, kept free of React so a fake viewport drives the same code the component runs. */
export function createTranscriptScroll(deps: TranscriptScrollDeps): TranscriptScroll {
  const landingRef = { current: false }
  const jumpCancelRef: JumpControl['jumpCancelRef'] = { current: null }
  const jumpTokenRef: JumpControl['jumpTokenRef'] = { current: 0 }
  const follow = createScrollFollow({
    getViewport: deps.getViewport,
    isLanding: () => landingRef.current,
    isRecentGesture: deps.isRecentGesture,
    record: deps.record,
    prefersReducedMotion: deps.prefersReducedMotion,
    onChange: deps.onChange
  })

  const jumpControl: JumpControl = {
    jumpCancelRef,
    jumpTokenRef,
    landingInProgressRef: landingRef,
    resetGesture: deps.resetGesture,
    setAutoScrollSuppressed: (suppressed) => follow.setState({ suppressed }),
    setIsAtEnd: (isAtEnd) => follow.setState({ isAtEnd }),
    markNewContent: () => follow.setState({ newContent: true }),
    syncHeight: follow.syncHeight,
    isTurnRunning: deps.isTurnRunning
  }

  function scrollToEnd() {
    if (!deps.getViewport()) return
    jumpCancelRef.current?.()
    landingRef.current = false
    follow.scrollToEnd()
  }

  function beginLanding(memory: SessionScrollState | undefined) {
    landingRef.current = true
    deps.resetGesture()
    // The new content's height is not growth of the old: forget the old one so the first resize only seeds it.
    follow.resetHeight()
    follow.setState({ suppressed: true, isAtEnd: memory === undefined || memory.atEnd, newContent: false })
  }

  let previous: { key: string; items: Sendable } | null = null
  function noteItems(landingKey: string, items: Sendable) {
    const before = previous
    previous = { key: landingKey, items }
    if (before && before.key === landingKey && isNewSend(before.items, items)) scrollToEnd()
  }

  return { follow, jumpControl, landingRef, scrollToEnd, beginLanding, noteItems }
}
