import { useEffect, useRef } from 'react'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { selectSessionChecklist, useChecklistStore, type ItemRefusal } from '@/state/checklist-store'
import type { Checklist } from '../../../../shared/checklist'
import { ChecklistRow } from './ChecklistRow'
import { containsFocus, focusFollowsReplace, type PanelView } from './checklist-focus'
import { useRevealRequest } from './reveal'
import { useChecklistAnnouncer } from './useChecklistAnnouncer'

interface ChecklistListProps {
  checklist: Checklist
  pending: Record<string, true>
  refusals: Record<string, ItemRefusal>
  onTick: (itemId: string) => void
}

/** The active checklist's rows, keyed by item id so a row keeps its focus and state across updates. */
export function ChecklistList({ checklist, pending, refusals, onTick }: ChecklistListProps) {
  return (
    <ol aria-label={checklist.title}>
      {checklist.items.map((item) => (
        <ChecklistRow key={item.id} item={item} pending={pending[item.id] === true} refusal={refusals[item.id]} onTick={() => onTick(item.id)} />
      ))}
    </ol>
  )
}

function Notice({ title, children }: { title: string; children: string }) {
  return (
    <div role="alert" className="mx-2 mt-2 rounded-lg border border-severity-error px-2 py-2 text-sm">
      <p className="font-medium">{title}</p>
      <p className="break-words text-muted-foreground">{children}</p>
    </div>
  )
}

/** The Checklist right-pane panel: the Session's active checklist, never an unexplained blank. */
export function ChecklistPanel({ sessionId }: { sessionId: string | null }) {
  const state = useChecklistStore((s) => selectSessionChecklist(s, sessionId))
  const line = useChecklistAnnouncer(sessionId)
  const regionRef = useRef<HTMLElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const { checklist, toolUnavailable, loaded, error, pending, refusals } = state

  const view: PanelView = { sessionId, checklistId: checklist?.id ?? null }
  const seen = useRef(view)
  const refocus = useRef(false)
  // Judged while the old rows are still in the DOM: once they unmount, focus is already on the body.
  if (focusFollowsReplace(seen.current, view, containsFocus(regionRef.current, regionRef.current?.ownerDocument.activeElement ?? null))) refocus.current = true
  seen.current = view
  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    regionRef.current?.focus()
  }, [view.checklistId])

  useRevealRequest({ sessionId, checklistId: view.checklistId, loaded }, scrollerRef)

  const done = checklist?.items.filter((item) => item.status === 'complete').length ?? 0
  const explained = error !== null || toolUnavailable
  return (
    <section ref={regionRef} tabIndex={-1} aria-label="Checklist" className="flex min-h-0 flex-1 flex-col outline-none">
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        <span key={line.serial}>{line.message}</span>
      </div>
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto pb-2">
        {error !== null && <Notice title="Couldn't load the checklist">{error}</Notice>}
        {toolUnavailable && <Notice title="Checklist tool unavailable">The agent's checklist tool was refused for this session, so it cannot create or update a checklist.</Notice>}
        {checklist !== null && (
          <>
            <div className="px-2 pb-1 pt-2">
              <h2 className="break-words text-sm font-medium">{checklist.title}</h2>
              <p className="text-xs text-muted-foreground">
                {done} of {checklist.items.length} {checklist.items.length === 1 ? 'item' : 'items'} complete
              </p>
            </div>
            {checklist.items.length === 0 ? (
              <p className="px-2 py-2 text-sm text-muted-foreground">This checklist has no items yet.</p>
            ) : (
              <ChecklistList
                checklist={checklist}
                pending={pending}
                refusals={refusals}
                onTick={(itemId) => {
                  if (sessionId !== null) void useChecklistStore.getState().mutateItem(sessionId, itemId)
                }}
              />
            )}
          </>
        )}
        {checklist === null && !explained && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{loaded || sessionId === null ? 'No checklist yet' : 'Loading checklist'}</EmptyTitle>
              <EmptyDescription>
                {loaded || sessionId === null ? 'When the agent creates a checklist for this session, it appears here.' : 'Checking whether the agent has made one.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </section>
  )
}
