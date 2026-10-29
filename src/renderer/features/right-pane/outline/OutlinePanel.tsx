// Outline panel (spec 041, #752): the right-pane tenant that lists the shown Session's messages
// (user messages top level, the agent's replies nested under their turn) and jumps the chat to
// one. It follows the focused pane's Session like Side chat and File explorer, reads the shared
// message index and scroller view from `useChatNavStore`, and is a plain list of buttons with a
// roving tabindex, not a tree widget.
import { forwardRef, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import { ChevronsDownUpIcon, ChevronsUpDownIcon, ListTreeIcon } from 'lucide-react'
import { Virtuoso, type ItemProps, type VirtuosoHandle } from 'react-virtuoso'
import { TOOLBAR_BUTTON_CLASS } from '@/components/toolbarButtonClass'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSessionsStore } from '@/state'
import { useChatNavStore } from '@/state/chat-nav-store'
import { focusChatMessage } from '../../chat-nav/focusChatMessage'
import { jumpToMessage } from '../../chat-nav/jumpToMessage'
import {
  buildOutlineRows,
  collapsibleTurnKeys,
  pruneCollapsed,
  resolveCurrentRowKey,
  stepRowIndex,
  type OutlineRow
} from '../../chat-nav/outlineModel'
import { OutlineRowItem } from './OutlineRowItem'

/** How long the list stays where the user scrolled it before it follows the chat again. */
const FOLLOW_PAUSE_MS = 3000

const EMPTY_INDEX: never[] = []

interface OutlineListContext {
  label: string
  size: number
}

const OutlineList = forwardRef<HTMLDivElement, ComponentProps<'div'> & { context?: OutlineListContext }>(function OutlineList(
  { context, ...props },
  ref
) {
  return <div ref={ref} role="list" aria-label={context?.label} {...props} />
})

function OutlineItemWrapper({ item: _item, context, ...rest }: ItemProps<OutlineRow> & { context?: OutlineListContext }) {
  const position = rest['data-index']
  return <div role="listitem" aria-posinset={position + 1} aria-setsize={context?.size} {...rest} />
}

const LIST_COMPONENTS = { List: OutlineList, Item: OutlineItemWrapper }

export function OutlinePanel({ sessionId }: { sessionId: string | null }) {
  const sessionName = useSessionsStore((s) => (sessionId ? s.sessions.find((session) => session.id === sessionId)?.name : undefined))
  const open = useChatNavStore((s) => (sessionId ? s.bySession[sessionId] !== undefined : false))
  if (!sessionId || !open) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ListTreeIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>No Session open</EmptyTitle>
          <EmptyDescription>Open a Session to see an outline of its messages.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return <OutlineBody key={sessionId} sessionId={sessionId} sessionName={sessionName ?? 'Session'} />
}

function OutlineBody({ sessionId, sessionName }: { sessionId: string; sessionName: string }) {
  const index = useChatNavStore((s) => s.bySession[sessionId]?.index ?? EMPTY_INDEX)
  const currentMessageId = useChatNavStore((s) => s.bySession[sessionId]?.view.currentMessageId ?? null)
  const [collapsedRaw, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const collapsed = useMemo(() => pruneCollapsed(collapsedRaw, index), [collapsedRaw, index])
  const rows = useMemo(() => buildOutlineRows(index, collapsed), [index, collapsed])
  const currentKey = useMemo(() => resolveCurrentRowKey(rows, index, currentMessageId), [rows, index, currentMessageId])
  const turnKeys = useMemo(() => collapsibleTurnKeys(index), [index])
  const allCollapsed = turnKeys.length > 0 && turnKeys.every((key) => collapsed.has(key))
  const allExpanded = !turnKeys.some((key) => collapsed.has(key))

  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const [renderedRange, setRenderedRange] = useState({ startIndex: 0, endIndex: 0 })
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const pendingFocusKey = useRef<string | null>(null)
  const lastListInteraction = useRef(0)
  const collapseReasonId = useId()
  const expandReasonId = useId()

  const wantedKey = rows.some((row) => row.key === focusedKey) ? focusedKey : (currentKey ?? rows[0]?.key ?? null)
  const wantedIndex = rows.findIndex((row) => row.key === wantedKey)
  // The wanted row may be virtualised out; the first rendered row then takes the tab stop so the list stays reachable.
  const wantedRendered = wantedIndex >= renderedRange.startIndex && wantedIndex <= renderedRange.endIndex
  const tabbableKey = wantedRendered ? wantedKey : (rows[Math.min(renderedRange.startIndex, rows.length - 1)]?.key ?? null)
  const currentIndex = currentKey === null ? -1 : rows.findIndex((row) => row.key === currentKey)

  // Keeps the current item in view as the chat scrolls, unless the user scrolled the list lately.
  useEffect(() => {
    if (currentIndex < 0) return
    const follow = () => virtuosoRef.current?.scrollIntoView({ index: currentIndex, behavior: 'auto' })
    const wait = FOLLOW_PAUSE_MS - (Date.now() - lastListInteraction.current)
    if (wait <= 0) {
      follow()
      return
    }
    const timer = window.setTimeout(() => {
      if (Date.now() - lastListInteraction.current >= FOLLOW_PAUSE_MS) follow()
    }, wait)
    return () => clearTimeout(timer)
  }, [currentIndex])

  // Finishes a keyboard move once Virtuoso has mounted the target row.
  useEffect(() => {
    const key = pendingFocusKey.current
    if (key === null) return
    const target = containerRef.current?.querySelector<HTMLElement>(`[data-outline-key="${CSS.escape(key)}"]`)
    if (!target) return
    pendingFocusKey.current = null
    target.focus({ preventScroll: true })
  }, [focusedKey, rows, renderedRange])

  const markInteraction = useCallback(() => {
    lastListInteraction.current = Date.now()
  }, [])

  const activate = useCallback(
    (row: OutlineRow, focusChat: boolean) => {
      setFocusedKey(row.key)
      if (jumpToMessage(sessionId, row.key) && focusChat) focusChatMessage(sessionId, row.key)
    },
    [sessionId]
  )

  const toggle = useCallback((row: OutlineRow) => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(row.key)) next.delete(row.key)
      else next.add(row.key)
      return next
    })
  }, [])

  const navigate = useCallback(
    (row: OutlineRow, key: 'ArrowUp' | 'ArrowDown' | 'Home' | 'End') => {
      markInteraction()
      const from = rows.findIndex((candidate) => candidate.key === row.key)
      const to = stepRowIndex(from, key, rows.length)
      const target = rows[to]
      if (!target) return
      pendingFocusKey.current = target.key
      setFocusedKey(target.key)
      virtuosoRef.current?.scrollIntoView({ index: to, behavior: 'auto' })
    },
    [rows, markInteraction]
  )

  const handleCollapseAll = () => {
    if (!allCollapsed && turnKeys.length > 0) setCollapsed(new Set(turnKeys))
  }
  const handleExpandAll = () => {
    if (!allExpanded) setCollapsed(new Set())
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="no-drag-region flex shrink-0 items-center gap-1 border-b border-divider px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={sessionName}>
          {sessionName}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Collapse all"
              aria-disabled={allCollapsed || turnKeys.length === 0 || undefined}
              aria-describedby={allCollapsed || turnKeys.length === 0 ? collapseReasonId : undefined}
              className={TOOLBAR_BUTTON_CLASS}
              onClick={handleCollapseAll}
            >
              <ChevronsDownUpIcon aria-hidden />
              {(allCollapsed || turnKeys.length === 0) && (
                <span id={collapseReasonId} className="sr-only">
                  {turnKeys.length === 0 ? 'No turns to collapse' : 'All turns are collapsed'}
                </span>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Collapse all</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Expand all"
              aria-disabled={allExpanded || undefined}
              aria-describedby={allExpanded ? expandReasonId : undefined}
              className={TOOLBAR_BUTTON_CLASS}
              onClick={handleExpandAll}
            >
              <ChevronsUpDownIcon aria-hidden />
              {allExpanded && (
                <span id={expandReasonId} className="sr-only">
                  All turns are expanded
                </span>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Expand all</TooltipContent>
        </Tooltip>
      </div>
      {rows.length === 0 ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ListTreeIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle>No messages yet</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <div
          ref={containerRef}
          className="min-h-0 flex-1"
          onWheel={markInteraction}
          onPointerDown={markInteraction}
          onTouchMove={markInteraction}
        >
          <Virtuoso
            ref={virtuosoRef}
            className="h-full"
            data={rows}
            computeItemKey={(_at, row) => row.key}
            components={LIST_COMPONENTS}
            context={{ label: `Outline of ${sessionName}`, size: rows.length }}
            rangeChanged={setRenderedRange}
            itemContent={(_at, row) => (
              <OutlineRowItem
                row={row}
                current={row.key === currentKey}
                tabbable={row.key === tabbableKey}
                onActivate={activate}
                onToggle={toggle}
                onNavigate={navigate}
                onFocusRow={(focused) => setFocusedKey(focused.key)}
              />
            )}
          />
        </div>
      )}
    </div>
  )
}
