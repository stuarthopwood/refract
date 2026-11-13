import * as React from 'react'
import { ArrowDownToLineIcon } from 'lucide-react'
import {
  FLOATING_ICON_BUTTON_CLASS,
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport
} from '@/components/ui/message-scroller'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { EMPTY_TRANSCRIPT, useActiveChatWidth, useChatScrollStore, usePendingRequestsStore, useSessionsStore, useSettingsStore, useStageToggleStore, useTranscriptStore } from '@/state'
import { type TranscriptDisplaySettings, type TranscriptItem } from '../../../shared/model'
import { FadeCollapse } from '@/components/FadeCollapse'
import { computeTurnEnd, hasNewerRealActivity } from './turnTiming'
import { isConversationStarted } from './isConversationStarted'
import { isAtScrollEnd, resolveLandingScrollTop, runScrollSettleLoop, useScrollGestureTracking } from './scrollLanding'
import { LinkContext } from './Markdown'
import { groupAdvisoryItems, isAdvisoryRun, type AdvisoryGroupedTranscriptItem } from './groupAdvisoryItems'
import { groupToolItems, isToolGroup } from './groupToolItems'
import { groupThoughtItems } from './groupThoughtItems'
import { groupMidTurnProse } from './groupMidTurnProse'
import { groupSubagentStages, isStageGroup, type StageGroup } from './groupSubagentStages'
import { SubagentChainRow } from './SubagentChainRow'
import { UpNextList } from './UpNextList'
import { formatElapsed } from './formatElapsed'
import { ToolGroupRow } from './ToolRow'
import { CHAT_ROW_GAP_CLASS, DEFAULT_CHAT_ROW_DENSITY } from '../../../shared/chatRowDensity'
import { isBookkeepingRow, rowVisibility, type RowVisibility } from './transcriptRowVisibility'
import { toolStatusLabel } from './toolStatus'
import { toolRunningAnnouncement, toolVerb } from './toolVerbs'
import { resolveToolDisplay } from './toolDisplay'
import { NO_PENDING, TranscriptRow, type ToolItem } from './TranscriptRow'
import { newestRunningRowId } from './newestRunningRow'
import { findPrecedingAskItem } from './findPrecedingAskItem'
import { type UserItem } from './UserMessageRow'
import { useRepositoryAvatarUrl } from './useRepositoryAvatarUrl'
import { useStageSettleAnnouncement } from './useStageSettleAnnouncement'
import { loadEarlierAnnouncement, restoreScrollTop, windowTranscriptTurns } from './windowTranscriptTurns'
import { JumpToStageContext, stageRowDomId } from './stageJump'
import { ChatNavBridge } from '../chat-nav/ChatNavBridge'
import { ChatNavOverlays } from '../chat-nav/ChatNavOverlays'
import { startRowJumpLoop, type JumpControl } from '../chat-nav/rowJumpLoop'
import { IconButton } from '@/components/IconButton'

const ANNOUNCEMENT_MAX_CHARS = 80
function clampAnnouncement(text: string | undefined): string | undefined {
  if (!text) return text
  const chars = Array.from(text)
  return chars.length > ANNOUNCEMENT_MAX_CHARS ? `${chars.slice(0, ANNOUNCEMENT_MAX_CHARS - 1).join('')}…` : text
}


const userNameCache = new Map<string, string>()

function useRepositoryUserName(repositoryId: string | null): string | undefined {
  const [name, setName] = React.useState<string | undefined>(repositoryId ? userNameCache.get(repositoryId) : undefined)
  React.useEffect(() => {
    if (!repositoryId) {
      setName(undefined)
      return
    }
    const cached = userNameCache.get(repositoryId)
    if (cached !== undefined) {
      setName(cached)
      return
    }
    let cancelled = false
    void window.refract.repositories.userName(repositoryId).then((result) => {
      if (cancelled || !result.ok) return
      userNameCache.set(repositoryId, result.value)
      setName(result.value)
    })
    return () => {
      cancelled = true
    }
  }, [repositoryId])
  return name
}

interface Turn {
  userItem: UserItem | null
  items: TranscriptItem[]
}

// Any items ahead of the first `user` item (should not normally occur) form a leading turn with no
// total-time line (`userItem: null`).
function splitIntoTurns(items: TranscriptItem[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn = { userItem: null, items: [] }
  for (const item of items) {
    if (item.kind === 'user') {
      if (current.items.length > 0) turns.push(current)
      current = { userItem: item, items: [item] }
    } else {
      current.items.push(item)
    }
  }
  turns.push(current)
  return turns
}

interface TurnTotalLineProps {
  turn: Turn
  isLastTurn: boolean
  isTurnRunning: boolean
  receivedAt: Record<string, number>
}

function TurnTotalLine({ turn, isLastTurn, isTurnRunning, receivedAt }: TurnTotalLineProps) {
  const settledEnd = computeTurnEnd(turn.items, receivedAt)
  const [lastSettledEnd, setLastSettledEnd] = React.useState<number | null | undefined>(() =>
    isLastTurn && isTurnRunning ? undefined : (settledEnd ?? null)
  )
  const showFinishedTurnTimes = useSettingsStore((state) => state.settings.showFinishedTurnTimes === true)
  React.useEffect(() => {
    if (!(isLastTurn && isTurnRunning)) setLastSettledEnd(settledEnd ?? null)
  }, [isLastTurn, isTurnRunning, settledEnd])
  if (!turn.userItem || turn.userItem.at === 0) return null
  const running =
    isLastTurn &&
    isTurnRunning &&
    (lastSettledEnd === undefined || (lastSettledEnd === null ? settledEnd !== undefined : hasNewerRealActivity(turn.items, receivedAt, lastSettledEnd)))
  const end = running ? Date.now() : settledEnd
  // The line fades and collapses out instead of vanishing, so the content below does not jump (#1250).
  const elapsed = end === undefined ? '' : formatElapsed(Math.max(0, end - turn.userItem.at))
  const content =
    end === undefined || (!running && !showFinishedTurnTimes) ? null : (
      <div aria-hidden={running || undefined} className="mt-6 px-2 py-1 text-xs text-muted-foreground">
        {/* The sr-only text adds the context a bare "28s" lacks when un-hidden inside the `log` live region. */}
        <span aria-hidden="true">{elapsed}</span>
        <span className="sr-only">Turn took {elapsed}</span>
      </div>
    )
  return <FadeCollapse show={content !== null}>{content}</FadeCollapse>
}

const TURN_GAP_CLASS = 'mt-6'

const TIME_GAP_THRESHOLD_MS = 60 * 60 * 1000

function shouldShowTimeGapDivider(previousAt: number, nextAt: number): boolean {
  if (new Date(previousAt).toDateString() !== new Date(nextAt).toDateString()) return true
  return nextAt - previousAt > TIME_GAP_THRESHOLD_MS
}

// `data-slot` (not a role) lets a live-check/test identify this row without re-adding an ARIA name.
function TimeGapDivider({ at }: { at: number }) {
  const label = new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <div data-slot="time-gap-divider" className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      <span>{label}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
  )
}

export function Transcript({
  sessionId,
  hasHistory,
  startNotice
}: {
  sessionId: string
  hasHistory: boolean
  startNotice?: (dimmed: boolean) => React.ReactElement
}) {
  const transcript = useTranscriptStore((state) => state.bySession[sessionId] ?? EMPTY_TRANSCRIPT)
  const session = useSessionsStore((state) => state.sessions.find((s) => s.id === sessionId))
  const transcriptDisplay = useSettingsStore((state) => state.settings.transcriptDisplay)
  const rowDensity = useSettingsStore((state) => state.settings.chatRowDensity ?? DEFAULT_CHAT_ROW_DENSITY)
  // Issue #554: 'reading-column' caps at 64rem, centred, transcript only.
  const chatWidth = useActiveChatWidth()
  const items = transcript.items
  const receivedAt = transcript.receivedAt
  const hasConversationStarted = isConversationStarted(items)
  const dimTranscript = Boolean(startNotice) && (hasHistory || hasConversationStarted)
  const pendingBySession = usePendingRequestsStore((state) => state.bySession)
  const pending = pendingBySession[sessionId] ?? NO_PENDING

  const userName = useRepositoryUserName(session?.repositoryId ?? null)
  const userAvatarUrl = useRepositoryAvatarUrl(session?.repositoryId ?? null)
  const isTurnRunning = session?.status === 'working' || session?.status === 'needs-you'

  // Re-renders the running turn's total-time line every second; the running turn is the only one
  // whose elapsed time is ever recomputed from `Date.now()` rather than frozen item timestamps, so
  // nothing else needs to re-render on this tick.
  const [, forceTick] = React.useReducer((count: number) => count + 1, 0)
  React.useEffect(() => {
    if (!isTurnRunning) return
    const interval = setInterval(forceTick, 1000)
    return () => clearInterval(interval)
  }, [isTurnRunning])

  // Rows receive only their own link (never the whole map), so a patch re-renders only the row it
  // changed.
  const askLinks = React.useMemo(() => {
    const askByRequestId = new Map<string, ToolItem | undefined>()
    const requestIdByAskItemId = new Map<string, string>()
    items.forEach((item, index) => {
      if (item.kind !== 'request') return
      const ask = findPrecedingAskItem(items, index)
      askByRequestId.set(item.requestId, ask)
      if (ask && !requestIdByAskItemId.has(ask.id)) requestIdByAskItemId.set(ask.id, item.requestId)
    })
    return { askByRequestId, requestIdByAskItemId }
  }, [items])
  const handleAdvisoryReveal = React.useCallback(() => setSuppressLogAnnouncements(true), [])

  const turns = React.useMemo(() => splitIntoTurns(items), [items])

  const [revealedEarlier, setRevealedEarlier] = React.useState(false)
  const [revealedAnnouncement, setRevealedAnnouncement] = React.useState('')
  const loadEarlierAnchorRef = React.useRef<number | null>(null)
  const [suppressLogAnnouncements, setSuppressLogAnnouncements] = React.useState(false)
  const { visible: visibleTurns, hiddenCount } = React.useMemo(
    () => windowTranscriptTurns(turns, revealedEarlier),
    [turns, revealedEarlier]
  )

  const turnsWithStages = React.useMemo(
    () =>
      visibleTurns.map((turn) => {
        const viewItems = transcriptDisplay.thinking ? turn.items : turn.items.filter((item) => item.kind !== 'thinking')
        const groupedWithStages = groupMidTurnProse(groupAdvisoryItems(groupSubagentStages(groupThoughtItems(groupToolItems(viewItems)))))
        return { turn, groupedWithStages, stages: groupedWithStages.filter(isStageGroup) }
      }),
    [visibleTurns, transcriptDisplay.thinking]
  )

  const stageAnnouncement = useStageSettleAnnouncement(turnsWithStages)
  let isFirstRow = true

  const viewportRef = React.useRef<HTMLDivElement>(null)
  const scrollerRootRef = React.useRef<HTMLDivElement>(null)
  const buttonRef = React.useRef<HTMLButtonElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const { isRecentGesture, resetGesture, gestureProps } = useScrollGestureTracking()
  const lastScrollTopRef = React.useRef(0)
  const landingInProgressRef = React.useRef(false)

  const jumpCancelRef = React.useRef<(() => void) | null>(null)
  const jumpTokenRef = React.useRef(0)

  const [autoScrollSuppressed, setAutoScrollSuppressed] = React.useState(false)
  const [isAtEnd, setIsAtEnd] = React.useState(true)

  const landingKey = `${sessionId}:${transcript.generation}`
  const [prevLandingKey, setPrevLandingKey] = React.useState(landingKey)
  if (prevLandingKey !== landingKey) {
    setPrevLandingKey(landingKey)
    landingInProgressRef.current = true; resetGesture()
    if (!autoScrollSuppressed) setAutoScrollSuppressed(true)
    const targetMemory = useChatScrollStore.getState().bySession[sessionId]
    setIsAtEnd(targetMemory === undefined || targetMemory.atEnd)
    if (revealedEarlier) setRevealedEarlier(false)
    if (revealedAnnouncement) setRevealedAnnouncement('')
    if (suppressLogAnnouncements) setSuppressLogAnnouncements(false)
  }

  // Also the only place that lifts a persisted detached-restore suppression (see
  // `autoScrollSuppressed` above): once the developer scrolls back to the end themselves, the
  // vendored scroller's own follow-the-bottom behaviour is safe to re-enable.
  function handleViewportScroll(event: React.UIEvent<HTMLDivElement>) {
    if (landingInProgressRef.current) return
    const viewport = event.currentTarget
    const atEnd = isAtScrollEnd({
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight
    })
    useChatScrollStore.getState().record(sessionId, { atEnd, scrollTop: viewport.scrollTop })
    const movedUp = viewport.scrollTop < lastScrollTopRef.current; lastScrollTopRef.current = viewport.scrollTop
    if (atEnd !== !autoScrollSuppressed && (atEnd || (movedUp && isRecentGesture()))) setAutoScrollSuppressed(!atEnd)
    setIsAtEnd(atEnd)
  }

  function handleScrollToEnd() {
    const viewport = viewportRef.current
    if (!viewport) return
    jumpCancelRef.current?.()
    landingInProgressRef.current = false
    const target = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    viewport.scrollTop = target
    useChatScrollStore.getState().record(sessionId, { atEnd: true, scrollTop: target })
    setAutoScrollSuppressed(false)
    setIsAtEnd(true)
  }

  function handleLoadEarlier() {
    const viewport = viewportRef.current
    loadEarlierAnchorRef.current = viewport ? viewport.scrollHeight - viewport.scrollTop : null
    setRevealedAnnouncement(loadEarlierAnnouncement(hiddenCount))
    setSuppressLogAnnouncements(true)
    setRevealedEarlier(true)
  }

  React.useLayoutEffect(() => {
    const anchor = loadEarlierAnchorRef.current
    if (anchor === null) return
    loadEarlierAnchorRef.current = null
    const viewport = viewportRef.current
    if (viewport) {
      viewport.scrollTop = restoreScrollTop(viewport.scrollHeight, anchor)
      viewport.focus({ preventScroll: true })
    }
  }, [visibleTurns])

  React.useEffect(() => {
    if (!suppressLogAnnouncements) return
    const frame = requestAnimationFrame(() => setSuppressLogAnnouncements(false))
    return () => cancelAnimationFrame(frame)
  }, [suppressLogAnnouncements])

  React.useLayoutEffect(() => {
    if (!isAtEnd) return
    if (document.activeElement !== buttonRef.current) return
    viewportRef.current?.focus({ preventScroll: true })
  }, [isAtEnd])

  React.useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      landingInProgressRef.current = false
      setAutoScrollSuppressed(false)
      return
    }
    // Falls back to the viewport itself only if the root ref somehow is not attached yet (it is
    // always rendered as the viewport's own parent below, so this is defensive, not expected).
    const root = scrollerRootRef.current ?? viewport
    jumpCancelRef.current?.()
    jumpTokenRef.current += 1
    landingInProgressRef.current = true; resetGesture()
    const cancel = runScrollSettleLoop(root, viewport, {
      computeTarget: ({ scrollHeight, clientHeight }) => {
        const memory = useChatScrollStore.getState().bySession[sessionId]
        return resolveLandingScrollTop(memory, scrollHeight, clientHeight)
      },
      onSettled: (landedAtEnd) => {
        landingInProgressRef.current = false
        setAutoScrollSuppressed(!landedAtEnd)
        setIsAtEnd(landedAtEnd)
      },
      // Resumes `autoScroll` only when that position is at the end; clearing it unconditionally re-engaged it mid-collapse.
      onInterrupted: (atEnd) => {
        useChatScrollStore.getState().record(sessionId, { atEnd, scrollTop: viewport.scrollTop })
        landingInProgressRef.current = false
        setAutoScrollSuppressed(!atEnd)
        setIsAtEnd(atEnd)
      },
      onAborted: () => {}
    })
    return () => {
      cancel()
      landingInProgressRef.current = false
    }
  }, [sessionId, transcript.generation])

  const jumpControl: JumpControl = { jumpCancelRef, jumpTokenRef, landingInProgressRef, resetGesture, setAutoScrollSuppressed, setIsAtEnd }
  // `jumpToMessage` reveals windowed-out turns without "Load earlier"'s anchor restore (it would
  // fight the jump).
  const revealEarlierForJump = () => {
    setSuppressLogAnnouncements(true)
    setRevealedEarlier(true)
  }
  const jumpToStageRow = React.useCallback(
    (stageId: string) => {
      const row = document.getElementById(stageRowDomId(sessionId, stageId))
      if (!row) return
      if (sessionId != null) useStageToggleStore.getState().setManualOpen(sessionId, stageId, true)
      row.focus({ preventScroll: true })
      const viewport = viewportRef.current
      const root = scrollerRootRef.current ?? viewport
      if (!viewport || !root) return
      startRowJumpLoop({ sessionId, root, viewport, row, control: jumpControl })
    },
    [sessionId]
  )

  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const observer = new ResizeObserver(() => {
      if (landingInProgressRef.current) return
      setIsAtEnd(
        isAtScrollEnd({
          scrollTop: viewport.scrollTop,
          scrollHeight: viewport.scrollHeight,
          clientHeight: viewport.clientHeight
        })
      )
    })
    observer.observe(viewport)
    if (contentRef.current) observer.observe(contentRef.current)
    return () => {
      observer.disconnect()
      jumpCancelRef.current?.()
    }
  }, [])

  return (
    <JumpToStageContext.Provider value={jumpToStageRow}>
    <LinkContext.Provider value={sessionId}>
    <MessageScrollerProvider autoScroll={!autoScrollSuppressed} defaultScrollPosition="end" scrollPreviousItemPeek={0}>
      <ChatNavBridge
        sessionId={sessionId}
        items={items}
        hiddenTurnCount={hiddenCount}
        viewportRef={viewportRef}
        scrollerRootRef={scrollerRootRef}
        control={jumpControl}
        revealEarlier={revealEarlierForJump}
      />
      <MessageScroller ref={scrollerRootRef} className="h-full flex-1">
        <MessageScrollerViewport
          ref={viewportRef}
          onScroll={handleViewportScroll}
          {...gestureProps}
          role="region"
          tabIndex={0}
          aria-label="Transcript"
          // `ring-inset` so the focus ring is not clipped by `overflow-y-auto` and the root's `overflow-hidden`.
          className={cn(
            'peer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
            dimTranscript && 'opacity-40 focus-within:opacity-100'
          )}
        >
          <MessageScrollerContent
            ref={contentRef}
            data-text-role="chat"
            className={cn('w-full px-4 pe-16 py-4', chatWidth === 'reading-column' && 'mx-auto max-w-[64rem] px-6 pe-16 @min-[40rem]:px-10 @min-[40rem]:pe-16 @min-[48rem]:px-14 @min-[48rem]:pe-16 @min-[64rem]:px-16')}
            aria-live={suppressLogAnnouncements ? 'off' : undefined}
          >
            {!hasHistory && !hasConversationStarted && !startNotice && (
              <div className="px-2 py-8 text-center text-sm text-muted-foreground">
                Ready. Type a message to get started.
              </div>
            )}
            {hasConversationStarted && hiddenCount > 0 && (
              <div className="px-2 pb-2">
                <Button type="button" variant="ghost" size="sm" onClick={handleLoadEarlier}>
                  Load {hiddenCount} earlier turn{hiddenCount === 1 ? '' : 's'}
                </Button>
              </div>
            )}
            {hasConversationStarted &&
              turnsWithStages.map(({ turn, groupedWithStages, stages }, turnIndex) => {
                const previousTurn = turnIndex > 0 ? visibleTurns[turnIndex - 1] : undefined
                const showTimeGapDivider =
                  previousTurn?.userItem != null &&
                  previousTurn.userItem.at !== 0 &&
                  turn.userItem != null &&
                  turn.userItem.at !== 0 &&
                  shouldShowTimeGapDivider(previousTurn.userItem.at, turn.userItem.at)

                let previousRow: AdvisoryGroupedTranscriptItem | undefined

                const isActiveTurn = turnIndex === visibleTurns.length - 1 && isTurnRunning
                const basePairs = groupedWithStages.map(
                  (row): [AdvisoryGroupedTranscriptItem, RowVisibility] => [row, rowVisibility(row, transcriptDisplay)]
                )
                const lastSrOnlyIndex = isActiveTurn ? basePairs.findLastIndex(([, visibility]) => visibility === 'sr-only') : -1
                const rows = basePairs
                  .map(([row, visibility], pairIndex): [AdvisoryGroupedTranscriptItem, RowVisibility] =>
                    visibility === 'sr-only' && pairIndex !== lastSrOnlyIndex ? [row, 'hidden'] : [row, visibility]
                  )
                  .filter(([, visibility]) => visibility !== 'hidden')

                const shimmerRowId = isActiveTurn ? newestRunningRowId(rows.filter(([, visibility]) => visibility === 'visible').map(([row]) => row)) : undefined
                const announceThinking =
                  !transcriptDisplay.thinking &&
                  turn.items.some((item) => item.kind === 'thinking' && item.streaming) &&
                  !rows.some(([, visibility]) => visibility === 'sr-only')

                return (
                  <React.Fragment key={turn.userItem?.id ?? `turn-${turnIndex}`}>
                    {showTimeGapDivider && turn.userItem != null && <TimeGapDivider at={turn.userItem.at} />}
                    {rows.map(([row, visibility]) => {
                      if (visibility === 'sr-only') {
                        return (
                          <MessageScrollerItem
                            key={row.id}
                            messageId={row.id}
                            className="[content-visibility:visible] [contain-intrinsic-size:none]"
                          >
                            {/* Only a `ToolGroup` or `StageGroup` returns `'sr-only'`; the final `undefined` is for the type checker. */}
                            <span className="sr-only">
                              {isStageGroup(row)
                                ? `${toolStatusLabel('running')} Stage ${row.stageIndex}`
                                : isToolGroup(row)
                                  ? clampAnnouncement(row.items[0]!.intent?.trim()) ||
                                    [
                                      toolRunningAnnouncement(row.items[0]!.skill ? 'skill' : resolveToolDisplay(row.tool, row.items[0]!.target).entryTool),
                                      row.items[0]!.skill?.name
                                    ].filter(Boolean).join(' ')
                                  : undefined}
                            </span>
                          </MessageScrollerItem>
                        )
                      }
                      const marginClass = isFirstRow
                        ? undefined
                        : previousRow && isBookkeepingRow(previousRow) && isBookkeepingRow(row)
                          ? CHAT_ROW_GAP_CLASS[rowDensity]
                          : TURN_GAP_CLASS
                      isFirstRow = false
                      previousRow = row
                      return (
                        <MessageScrollerItem key={row.id} messageId={row.id} className={marginClass}>
                          <TranscriptRow
                            item={row}
                            sessionId={sessionId}
                            pending={pending}
                            userName={userName} userAvatarUrl={userAvatarUrl} hideTime={showTimeGapDivider && row.kind === 'user'}
                            resolvedAsk={row.kind === 'request' ? askLinks.askByRequestId.get(row.requestId) : undefined}
                            askRequestId={row.kind === 'tool' ? askLinks.requestIdByAskItemId.get(row.id) : undefined}
                            shimmer={row.id === shimmerRowId}
                            onAdvisoryReveal={handleAdvisoryReveal} onQueuedAnnounce={setRevealedAnnouncement}
                          />
                        </MessageScrollerItem>
                      )
                    })}
                    {announceThinking && <span className="sr-only">{toolVerb('thinking', 'running')}</span>}
                    <SubagentChainRow stages={stages} sessionId={sessionId} />
                    <UpNextList sessionId={sessionId} stagesCount={stages.length} isLastTurn={turnIndex === visibleTurns.length - 1} />
                    <TurnTotalLine
                      turn={turn}
                      isLastTurn={turnIndex === visibleTurns.length - 1}
                      isTurnRunning={isTurnRunning}
                      receivedAt={receivedAt}
                    />
                  </React.Fragment>
                )
              })}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        {startNotice && (
          <div
            data-start-overlay
            className={cn(
              'pointer-events-none absolute inset-0 flex items-center-safe justify-center overflow-y-auto p-2 transition-opacity duration-150',
              // Over visible history the transcript's own bar owns this edge; a second one here would sit beside it.
              dimTranscript && 'no-scrollbar peer-focus-within:opacity-0'
            )}
          >
            <div
              data-start-notice-wrapper
              className={cn('pointer-events-auto', dimTranscript && '[.peer:focus-within~[data-start-overlay]_&]:pointer-events-none')}
            >
              {startNotice(dimTranscript)}
            </div>
          </div>
        )}
        {/* Always mounted: a live region created together with its text is generally not announced. */}
        <span role="status" aria-live="polite" className="sr-only">
          {revealedAnnouncement}
        </span>
        <span role="status" aria-live="polite" className="sr-only">
          {stageAnnouncement}
        </span>
        <ChatNavOverlays sessionId={sessionId} />
        <IconButton
          ref={buttonRef}
          variant="ghost"
          label="Scroll to end"
          inert={isAtEnd}
          onClick={handleScrollToEnd}
          className={cn(
            FLOATING_ICON_BUTTON_CLASS,
            "absolute inset-e-6 bottom-4 transition-[translate,scale,opacity] duration-200",
            isAtEnd
              ? "pointer-events-none translate-y-full scale-95 opacity-0 duration-400 ease-[cubic-bezier(0.7,0,0.84,0)]"
              : "translate-y-0 scale-100 opacity-100 ease-[cubic-bezier(0.23,1,0.32,1)]"
          )}
        >
          <ArrowDownToLineIcon />
        </IconButton>
      </MessageScroller>
    </MessageScrollerProvider>
    </LinkContext.Provider>
    </JumpToStageContext.Provider>
  )
}
