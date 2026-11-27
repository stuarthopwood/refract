import type * as React from 'react'
import { isAtScrollEnd, runScrollSettleLoop } from '../chat/scrollLanding'
import { jumpTopInset } from './jumpTopInset'
import { useChatScrollStore } from '@/state'

/** The `Transcript` state a programmatic jump has to claim and release around its settle loop. */
export interface JumpControl {
  jumpCancelRef: React.MutableRefObject<(() => void) | null>
  jumpTokenRef: React.MutableRefObject<number>
  landingInProgressRef: React.MutableRefObject<boolean>
  resetGesture: () => void
  setAutoScrollSuppressed: (suppressed: boolean) => void
  setIsAtEnd: (atEnd: boolean) => void
  /** Records the content height as seen when a landing ends, so what grew meanwhile does not raise a false new-content dot. */
  syncHeight: () => void
}

export interface RowJumpLoopOptions {
  sessionId: string
  root: HTMLElement
  viewport: HTMLElement
  row: HTMLElement
  control: JumpControl
  /** Runs once when the loop settles on its own (not when a user input interrupts it). */
  onLanded?: (row: HTMLElement) => void
}

/** Scrolls `row` to the viewport top (minus the jump margin) with the shared settle loop, and
 * detaches from autoscroll until the view is genuinely at the end again. Shared by "Go to Stage N"
 * and `jumpToMessage` so both fight `content-visibility` row growth the same way (#485, #1008).
 * Detaching sets `autoScroll` off, so the scroller does not drag the view back to the end while the
 * turn streams (#1021). */
export function startRowJumpLoop({ sessionId, root, viewport, row, control, onLanded }: RowJumpLoopOptions): void {
  const { jumpCancelRef, jumpTokenRef, landingInProgressRef, resetGesture, setAutoScrollSuppressed, setIsAtEnd, syncHeight } = control
  // A new jump always wins over a still-running previous one; its token guards `onAborted` below.
  jumpCancelRef.current?.()
  const myToken = ++jumpTokenRef.current
  const isViewportAtEnd = () => isAtScrollEnd({ scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight })
  const releaseAtCurrentPosition = () => {
    landingInProgressRef.current = false
    syncHeight()
    const atEnd = isViewportAtEnd()
    setAutoScrollSuppressed(!atEnd)
    setIsAtEnd(atEnd)
  }
  landingInProgressRef.current = true
  resetGesture()
  setAutoScrollSuppressed(true)
  const cancel = runScrollSettleLoop(root, viewport, {
    // A Session/Conversation switch mid-loop can remove the row; stop touching `scrollTop` for a gone target.
    shouldAbort: () => !row.isConnected || !viewport.contains(row),
    computeTarget: ({ scrollTop, scrollHeight, clientHeight }) => {
      const rowRect = row.getBoundingClientRect()
      const viewportRect = viewport.getBoundingClientRect()
      const maxScrollTop = Math.max(0, scrollHeight - clientHeight)
      const raw = scrollTop + (rowRect.top - viewportRect.top) - jumpTopInset(viewport)
      return Math.max(0, Math.min(raw, maxScrollTop))
    },
    onSettled: (landedAtEnd) => {
      landingInProgressRef.current = false
      syncHeight()
      useChatScrollStore.getState().record(sessionId, { atEnd: landedAtEnd, scrollTop: viewport.scrollTop })
      setAutoScrollSuppressed(!landedAtEnd)
      setIsAtEnd(landedAtEnd)
      onLanded?.(row)
    },
    onInterrupted: (atEnd) => {
      useChatScrollStore.getState().record(sessionId, { atEnd, scrollTop: viewport.scrollTop })
      landingInProgressRef.current = false
      syncHeight()
      setAutoScrollSuppressed(!atEnd)
      setIsAtEnd(atEnd)
    },
    onAborted: () => {
      if (jumpTokenRef.current !== myToken) return
      releaseAtCurrentPosition()
    }
  })
  jumpCancelRef.current = cancel
}
