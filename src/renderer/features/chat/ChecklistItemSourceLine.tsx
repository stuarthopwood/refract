import { useEffect } from 'react'
import { ListChecksIcon } from 'lucide-react'
import { SourceTag, type SourceTagAction } from '@/components/SourceTag'
import { selectSessionChecklist, useChecklistStore } from '@/state/checklist-store'
import type { MessageSource } from '../../../shared/model'
import { hydrateIfUnseen, showInChecklist } from './checklistItemActions'
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
  const detail = line.kind === 'item' ? line.text : undefined
  return (
    <div className="mb-1 flex min-w-0 justify-end text-xs">
      {/* The id names the bubble, so it sits on the words alone and leaves "Show in checklist" out. */}
      <SourceTag icon={ListChecksIcon} label={labelFor(line)} detail={detail} tooltip={detail} action={action} nameId={id} />
    </div>
  )
}
