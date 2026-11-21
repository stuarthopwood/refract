import { useEffect } from 'react'
import { ListChecksIcon } from 'lucide-react'
import { SourceTag, type SourceTagAction } from '@/components/SourceTag'
import { selectSessionChecklist, useChecklistStore } from '@/state/checklist-store'
import { useRightPaneStore } from '@/state/right-pane-store'
import { useSplitStore } from '@/state/split-store'
import type { MessageSource } from '../../../shared/model'
import { resolveChecklistItemLine, type ChecklistItemLine } from './checklistItemLine'

interface ChecklistItemSourceLineProps {
  source: Extract<MessageSource, { kind: 'checklist-item' }>
  /** The Session whose transcript holds this turn; in a split it is not always the focused one. */
  sessionId: string | null
  /** Names the line so the bubble can take its accessible name from it. */
  id: string
}

function labelFor(line: ChecklistItemLine): string {
  if (line.kind === 'item') return `Checklist item ${line.position}:`
  if (line.kind === 'removed') return 'Checklist item (removed)'
  if (line.kind === 'replaced') return 'Checklist item (replaced checklist)'
  return 'Checklist item'
}

/** Only the focused Session is hydrated app-wide, so a card in the other split pane asks for its own checklist once. */
export function hydrateIfUnseen(sessionId: string): void {
  const store = useChecklistStore.getState()
  if (selectSessionChecklist(store, sessionId).seq === 0) void store.hydrate(sessionId)
}

/** Activates the card's own Session, then opens the panel and asks it to reveal the item. */
export function showInChecklist(sessionId: string, checklistId: string, itemId: string): void {
  useSplitStore.getState().replaceFocused(sessionId)
  useRightPaneStore.getState().openPanel('checklist', { focus: false })
  useChecklistStore.getState().requestReveal({ sessionId, checklistId, itemId })
}

/** "Checklist item N: <text>" above a user turn the developer sent from a checklist item. */
export function ChecklistItemSourceLine({ source, sessionId, id }: ChecklistItemSourceLineProps) {
  // Subscribed here, not in the row, so ordinary user turns never read the checklist store.
  const state = useChecklistStore((s) => selectSessionChecklist(s, sessionId))
  useEffect(() => {
    if (sessionId !== null) hydrateIfUnseen(sessionId)
  }, [sessionId])
  const line = resolveChecklistItemLine(state, source.checklistId, source.itemId)
  const action: SourceTagAction | undefined =
    line.kind === 'item' && sessionId !== null
      ? { label: 'Show in checklist', onActivate: () => showInChecklist(sessionId, source.checklistId, source.itemId) }
      : undefined
  return (
    <div id={id} className="mb-1 flex min-w-0 justify-end text-xs">
      <SourceTag icon={ListChecksIcon} label={labelFor(line)} detail={line.kind === 'item' ? line.text : undefined} action={action} />
    </div>
  )
}
