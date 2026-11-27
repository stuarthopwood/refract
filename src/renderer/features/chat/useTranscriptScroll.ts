import * as React from 'react'
import { useChatScrollStore } from '@/state'
import type { TranscriptItem } from '../../../shared/model'
import { isMotionReduced } from '@/lib/reducedMotion'
import { resolveLandingScrollTop, runScrollSettleLoop, useScrollGestureTracking } from './scrollLanding'
import type { FollowState } from './scrollFollow'
import { createTranscriptScroll } from './transcriptScroll'

interface UseTranscriptScrollOptions {
  sessionId: string
  generation: number
  items: readonly TranscriptItem[]
}

/** Wires one `Transcript`'s scroll behaviour: the follow-the-end policy (#459) and the landing on a Session's saved position. The logic lives in `createTranscriptScroll`; this binds it to the DOM and React. */
export function useTranscriptScroll({ sessionId, generation, items }: UseTranscriptScrollOptions) {
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const scrollerRootRef = React.useRef<HTMLDivElement>(null)
  const buttonRef = React.useRef<HTMLButtonElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const { isRecentGesture, resetGesture, gestureProps } = useScrollGestureTracking()
  const [followState, setFollowState] = React.useState<FollowState>({ suppressed: false, isAtEnd: true, newContent: false })

  // The callbacks below outlive a render (jump loops, the resize observer), so they read the id through a ref.
  const sessionIdRef = React.useRef(sessionId)
  React.useLayoutEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  const [scroll] = React.useState(() =>
    createTranscriptScroll({
      getViewport: () => viewportRef.current,
      isRecentGesture,
      resetGesture,
      record: (state) => useChatScrollStore.getState().record(sessionIdRef.current, state),
      prefersReducedMotion: isMotionReduced,
      onChange: setFollowState
    })
  )
  const { follow, jumpControl, landingRef } = scroll

  const landingKey = `${sessionId}:${generation}`
  const [prevLandingKey, setPrevLandingKey] = React.useState(landingKey)
  if (prevLandingKey !== landingKey) {
    setPrevLandingKey(landingKey)
    scroll.beginLanding(useChatScrollStore.getState().bySession[sessionId])
  }

  React.useLayoutEffect(() => {
    scroll.noteItems(landingKey, items)
  }, [items, landingKey, scroll])

  React.useLayoutEffect(() => {
    if (!followState.isAtEnd) return
    if (document.activeElement !== buttonRef.current) return
    viewportRef.current?.focus({ preventScroll: true })
  }, [followState.isAtEnd])

  React.useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      landingRef.current = false
      follow.setState({ suppressed: false })
      return
    }
    // Falls back to the viewport itself only if the root ref somehow is not attached yet (it is
    // always rendered as the viewport's own parent, so this is defensive, not expected).
    const root = scrollerRootRef.current ?? viewport
    jumpControl.jumpCancelRef.current?.()
    jumpControl.jumpTokenRef.current += 1
    landingRef.current = true
    resetGesture()
    const cancel = runScrollSettleLoop(root, viewport, {
      computeTarget: ({ scrollHeight, clientHeight }) =>
        resolveLandingScrollTop(useChatScrollStore.getState().bySession[sessionId], scrollHeight, clientHeight),
      onSettled: (landedAtEnd) => {
        landingRef.current = false
        follow.syncHeight()
        follow.setState({ suppressed: !landedAtEnd, isAtEnd: landedAtEnd })
      },
      // Resumes `autoScroll` only when that position is at the end; clearing it unconditionally re-engaged it mid-collapse.
      onInterrupted: (atEnd) => {
        useChatScrollStore.getState().record(sessionId, { atEnd, scrollTop: viewport.scrollTop })
        landingRef.current = false
        follow.syncHeight()
        follow.setState({ suppressed: !atEnd, isAtEnd: atEnd })
      },
      onAborted: () => {}
    })
    return () => {
      cancel()
      landingRef.current = false
    }
  }, [sessionId, generation])

  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const observer = new ResizeObserver(() => follow.handleResize())
    observer.observe(viewport)
    if (contentRef.current) observer.observe(contentRef.current)
    return () => {
      observer.disconnect()
      jumpControl.jumpCancelRef.current?.()
    }
  }, [follow, jumpControl])

  return {
    viewportRef,
    scrollerRootRef,
    buttonRef,
    contentRef,
    gestureProps,
    follow,
    jumpControl,
    followState,
    handleScrollToEnd: scroll.scrollToEnd
  }
}
