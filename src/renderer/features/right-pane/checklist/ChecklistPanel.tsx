import { useCallback, useEffect, useRef, type FocusEvent } from 'react'
import { ListChecksIcon } from 'lucide-react'
import { InlineStatus } from '@/components/InlineStatus'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { selectSessionChecklist, useChecklistStore, type ItemRefusal } from '@/state/checklist-store'
import type { Checklist } from '../../../../shared/checklist'
import { ChecklistRow } from './ChecklistRow'
import { blurLeavesRegion, containsFocus, shouldRefocus } from './checklist-focus'
import { loadErrorCopy, TOOL_UNAVAILABLE_COPY } from './checklist-load-error'
import { useRevealRequest } from './reveal'
import { useChecklistAnnouncer } from './useChecklistAnnouncer'

interface ChecklistListProps {
  sessionId: string
  checklist: Checklist
  pending: Record<string, true>
  refusals: Record<string, ItemRefusal>
  onTick: (itemId: string) => void
}

/** The active checklist's rows, keyed by item id so a row keeps its focus and state across updates. */
export function ChecklistList({ sessionId, checklist, pending, refusals, onTick }: ChecklistListProps) {
  return (
    // Item ids restart at i1 per checklist, so a replace must remount the rows past the memo.
    <ol key={checklist.id} aria-label={checklist.title}>
      {checklist.items.map((item) => (
        <ChecklistRow
          key={item.id}
          item={item}
          sessionId={sessionId}
          checklistId={checklist.id}
          pending={pending[item.id] === true}
          refusal={refusals[item.id]}
          onTick={onTick}
        />
      ))}
    </ol>
  )
}

interface EmptyStateProps {
  sessionId: string | null
  loaded: boolean
}

/** One persistent status wrapper, so loading turning into empty is announced as a text change. */
function NoChecklist({ sessionId, loaded }: EmptyStateProps) {
  return (
    <div role="status" className="flex min-h-0 flex-1 flex-col">
      {sessionId !== null && !loaded ? (
        <InlineStatus tone="loading">Loading checklist…</InlineStatus>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ListChecksIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle>{sessionId === null ? 'No Session open' : 'No checklist yet'}</EmptyTitle>
            <EmptyDescription>
              {sessionId === null ? 'Open a Session to see its checklist.' : 'When the agent creates a checklist for this session, it appears here.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  )
}

/** The Checklist right-pane panel: the Session's active checklist, never an unexplained blank. */
export function ChecklistPanel({ sessionId }: { sessionId: string | null }) {
  const state = useChecklistStore((s) => selectSessionChecklist(s, sessionId))
  const line = useChecklistAnnouncer(sessionId)
  const regionRef = useRef<HTMLElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const { checklist, toolUnavailable, loaded, error, errorCode, pending, refusals } = state

  const focusInside = useRef(false)
  const previousSession = useRef(sessionId)
  // Judged after commit: an unmounted focused item has already dropped focus to the body.
  useEffect(() => {
    const sameSession = previousSession.current === sessionId
    previousSession.current = sessionId
    const region = regionRef.current
    if (!sameSession) focusInside.current = false
    if (region === null) return
    if (shouldRefocus({ sameSession, focusWasInside: focusInside.current, focusStillInside: containsFocus(region, region.ownerDocument.activeElement) })) region.focus()
  }, [sessionId, checklist])

  useRevealRequest({ sessionId, checklistId: checklist?.id ?? null, loaded }, scrollerRef)

  const onTick = useCallback(
    (itemId: string) => {
      if (sessionId !== null) void useChecklistStore.getState().mutateItem(sessionId, itemId)
    },
    [sessionId]
  )
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (blurLeavesRegion(event.currentTarget, event.relatedTarget, event.target)) focusInside.current = false
  }

  const itemCount = checklist?.items.length ?? 0
  const done = checklist?.items.filter((item) => item.status === 'complete').length ?? 0
  const loadError = error !== null ? loadErrorCopy(errorCode, checklist !== null) : null
  return (
    <section
      ref={regionRef}
      tabIndex={-1}
      aria-label="Checklist"
      onFocus={() => {
        focusInside.current = true
      }}
      onBlur={onBlur}
      className="flex min-h-0 flex-1 flex-col focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
    >
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        <span key={line.serial}>{line.message}</span>
      </div>
      {loadError !== null && (
        <div className="no-drag-region flex shrink-0 items-center gap-2 border-b border-divider px-2 py-1">
          <InlineStatus tone="error" density="compact" className="min-w-0 flex-1 break-words p-0">
            {loadError.message}
          </InlineStatus>
          {loadError.retryable && sessionId !== null && (
            <Button type="button" variant="outline" size="xs" onClick={() => void useChecklistStore.getState().hydrate(sessionId)}>
              Retry
            </Button>
          )}
        </div>
      )}
      {toolUnavailable && (
        <InlineStatus tone="notice" density="compact" className="shrink-0 border-b border-divider">
          {TOOL_UNAVAILABLE_COPY}
        </InlineStatus>
      )}
      {checklist !== null && (
        <div className="shrink-0 border-b border-divider px-2 py-2">
          <h3 className="break-words text-sm font-medium">{checklist.title}</h3>
          {itemCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {done} of {itemCount} {itemCount === 1 ? 'item' : 'items'} complete
            </p>
          )}
        </div>
      )}
      <div ref={scrollerRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
        {checklist !== null ? (
          itemCount === 0 ? (
            <InlineStatus>This checklist has no items yet.</InlineStatus>
          ) : (
            sessionId !== null && <ChecklistList sessionId={sessionId} checklist={checklist} pending={pending} refusals={refusals} onTick={onTick} />
          )
        ) : (
          error === null && !toolUnavailable && <NoChecklist sessionId={sessionId} loaded={loaded} />
        )}
      </div>
    </section>
  )
}
