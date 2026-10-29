import * as React from 'react'
import { useMessageScroller, useMessageScrollerScrollable, useMessageScrollerVisibility } from '@/components/ui/message-scroller'
import { useChatNavStore, type ScrollBridge } from '@/state/chat-nav-store'
import type { TranscriptItem } from '../../../shared/model'
import { flashRowHighlight } from './highlightRow'
import { jumpTopInset } from './jumpTopInset'
import { isTurnWindowedOut } from './messageIndex'
import { findMessageRow as findRow } from './messageRow'
import { startRowJumpLoop, type JumpControl } from './rowJumpLoop'
import { useMessageIndexSync } from './useMessageIndexSync'

const REVEAL_WAIT_MAX_FRAMES = 60

export interface ChatNavBridgeProps {
  sessionId: string
  /** The FULL transcript items, not the rendered window. */
  items: readonly TranscriptItem[]
  hiddenTurnCount: number
  viewportRef: React.RefObject<HTMLDivElement | null>
  scrollerRootRef: React.RefObject<HTMLDivElement | null>
  control: JumpControl
  /** Reveals the turns `windowTranscriptTurns` hides, with no scroll anchor restore. */
  revealEarlier: () => void
}

/** Renders nothing. Mounted inside `MessageScrollerProvider`, it keeps the Session's message index
 * current and registers the scroller bridge in `useChatNavStore`, because the vendored hooks only
 * work inside that provider and the Outline, map and search live outside it. */
export function ChatNavBridge(props: ChatNavBridgeProps) {
  const { sessionId, items } = props
  const scroller = useMessageScroller()
  const scrollable = useMessageScrollerScrollable()
  const { visibleMessageIds } = useMessageScrollerVisibility()
  useMessageIndexSync(sessionId, items)

  const latest = React.useRef({ props, scroller })
  latest.current = { props, scroller }

  React.useEffect(() => {
    const bridge: ScrollBridge = {
      scrollToMessage: (id, options) => latest.current.scroller.scrollToMessage(id, options),
      scrollToStart: () => latest.current.scroller.scrollToStart(),
      scrollToEnd: () => latest.current.scroller.scrollToEnd(),
      revealEarlier: () => latest.current.props.revealEarlier(),
      getHiddenTurnCount: () => latest.current.props.hiddenTurnCount,
      getMessageTopOffset: (id) => {
        const { viewportRef, scrollerRootRef } = latest.current.props
        const viewport = viewportRef.current
        const row = viewport ? findRow(scrollerRootRef.current ?? viewport, id) : null
        return row && viewport
          ? row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - jumpTopInset(viewport)
          : null
      },
      jump: (id, options) => {
        const { props: p, scroller: s } = latest.current
        const viewport = p.viewportRef.current
        const root = p.scrollerRootRef.current ?? viewport
        const message = useChatNavStore.getState().bySession[p.sessionId]?.index.find((m) => m.id === id)
        if (!viewport || !root || !message) return false
        const highlight = options?.highlight !== false
        const land = (row: HTMLElement) => {
          s.scrollToMessage(id, { align: 'start', behavior: 'instant', scrollMargin: jumpTopInset(viewport) })
          startRowJumpLoop({
            sessionId: p.sessionId,
            root,
            viewport,
            row,
            control: p.control,
            onLanded: highlight ? flashRowHighlight : undefined
          })
        }
        const mounted = findRow(root, id)
        if (mounted) {
          land(mounted)
          return true
        }
        if (!isTurnWindowedOut(message.turnIndex, p.hiddenTurnCount)) return false
        // The row's turn is hidden: reveal it, then wait for the row to mount before landing.
        p.control.jumpCancelRef.current?.()
        const myToken = ++p.control.jumpTokenRef.current
        p.control.landingInProgressRef.current = true
        p.revealEarlier()
        let frames = 0
        let handle = 0
        const wait = () => {
          const row = findRow(root, id)
          if (row) {
            land(row)
            return
          }
          frames += 1
          if (frames >= REVEAL_WAIT_MAX_FRAMES) {
            if (p.control.jumpTokenRef.current === myToken) p.control.landingInProgressRef.current = false
            return
          }
          handle = requestAnimationFrame(wait)
        }
        handle = requestAnimationFrame(wait)
        p.control.jumpCancelRef.current = () => cancelAnimationFrame(handle)
        return true
      }
    }
    return useChatNavStore.getState().registerBridge(sessionId, bridge)
  }, [sessionId])

  const index = useChatNavStore((state) => state.bySession[sessionId]?.index)
  const visibleKey = visibleMessageIds.join('\n')

  // The current message is the first one with any part below the jump top inset: a jump lands its
  // target at that inset, so the previous message's tail above it must not count as current.
  const readCurrent = React.useCallback((): string | null => {
    if (!index || visibleMessageIds.length === 0) return null
    const visible = new Set(visibleMessageIds)
    const { viewportRef, scrollerRootRef } = latest.current.props
    const viewport = viewportRef.current
    const root = scrollerRootRef.current ?? viewport
    const candidates = index.filter((message) => visible.has(message.id))
    if (!viewport || !root) return candidates[0]?.id ?? null
    const edge = viewport.getBoundingClientRect().top + jumpTopInset(viewport) + 1
    const below = candidates.find((message) => {
      const row = findRow(root, message.id)
      return row === null || row.getBoundingClientRect().bottom > edge
    })
    return (below ?? candidates[0])?.id ?? null
    // `visibleKey` stands in for the array identity, which the library may change every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, visibleKey])

  const [currentMessageId, setCurrentMessageId] = React.useState<string | null>(null)
  React.useLayoutEffect(() => {
    setCurrentMessageId(readCurrent())
  }, [readCurrent])
  React.useEffect(() => {
    const viewport = latest.current.props.viewportRef.current
    if (!viewport) return
    let frame = 0
    const onScroll = () => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setCurrentMessageId(readCurrent())
      })
    }
    viewport.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      viewport.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
    }
  }, [readCurrent])

  React.useEffect(() => {
    useChatNavStore.getState().setView(sessionId, {
      scrollable: { start: scrollable.start, end: scrollable.end },
      visibleMessageIds,
      currentMessageId
    })
    // `visibleKey` stands in for the array identity, which the library may change every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, scrollable.start, scrollable.end, visibleKey, currentMessageId])

  return null
}
