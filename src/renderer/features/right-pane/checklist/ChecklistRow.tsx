import { Spinner } from '@/components/ui/spinner'
import { memo, useId } from 'react'
import { InlineStatus } from '@/components/InlineStatus'
import { CHECKBOX_BOX_ONLY_CLASS, CheckboxIndicator, CheckboxItem } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import type { ItemRefusal } from '@/state/checklist-store'
import type { ChecklistItem } from '../../../../shared/checklist'
import { refusalMessage, refusalTone } from './checklist-refusal'
import { CHECKLIST_STATUS_GLYPH } from './checklist-status'
import { ChecklistItemControls } from './ChecklistItemControls'
import { needsValueToTick } from './checklist-tick'

interface ChecklistRowProps {
  item: ChecklistItem
  /** Item ids restart per checklist, so the controls' drafts are keyed by both. */
  sessionId: string
  checklistId: string
  /** Whether the Session's agent is up; computed once by the panel. */
  agentRunning: boolean
  /** A `checklist.mutate` for this item is in flight. */
  pending: boolean
  refusal?: ItemRefusal
  onTick: (itemId: string) => void
}

const PLAIN_TEXT = 'whitespace-pre-wrap break-words'

/** One checklist item: tick, text, status with icon and word, who completed it, its value, and why a tick was refused. */
function ChecklistRowView({ item, sessionId, checklistId, agentRunning, pending, refusal, onTick }: ChecklistRowProps) {
  const id = useId()
  const textId = `${id}-text`
  const reasonId = `${id}-reason`
  const complete = item.status === 'complete'
  const needsValue = needsValueToTick(item)
  const { Icon, className, word, showWord } = CHECKLIST_STATUS_GLYPH[item.status]
  const completedBy = complete ? (item.completedBy ?? item.updatedBy) : undefined
  const statusId = `${id}-status`
  const describedBy = [showWord || completedBy !== undefined ? statusId : null, needsValue ? reasonId : null].filter((part) => part !== null).join(' ') || undefined

  return (
    <li
      data-slot="checklist-row"
      data-checklist-item={item.id}
      aria-current={item.status === 'next' ? 'step' : undefined}
      className="flex items-start gap-2 border-b border-divider px-2 py-2 text-sm last:border-b-0"
    >
      <span className="grid size-6 shrink-0 place-items-center">
        <CheckboxItem
          checked={complete}
          // Never `disabled`: that would drop focus to the body while the result is pending. The store ignores a tick while pending or still missing its value.
          aria-disabled={pending || needsValue}
          aria-busy={pending}
          aria-labelledby={textId}
          aria-describedby={describedBy}
          onCheckedChange={() => onTick(item.id)}
          className={cn(CHECKBOX_BOX_ONLY_CLASS, 'relative after:absolute after:-inset-1 after:content-[""]')}
        >
          {pending ? <Spinner className="size-3" /> : <CheckboxIndicator />}
        </CheckboxItem>
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span id={textId} className={PLAIN_TEXT}>
          {item.text}
        </span>
        {(showWord || completedBy !== undefined) && (
          <span id={statusId} className={cn('inline-flex items-center gap-1 text-xs', className)}>
            <Icon aria-hidden className="size-4 shrink-0" />
            {!showWord && <span className="sr-only">{word}</span>}
            {showWord && <span>{word}</span>}
            {completedBy !== undefined && <span className="text-muted-foreground">Completed by {completedBy === 'agent' ? 'the agent' : 'you'}</span>}
          </span>
        )}
        {item.value !== undefined && item.value !== '' && (
          <p className={cn('text-xs', PLAIN_TEXT)}>
            <span className="text-muted-foreground">Value: </span>
            {item.value}
          </p>
        )}
        {needsValue && (
          <p id={reasonId} className="text-xs text-muted-foreground">
            This item needs a value before it can be ticked.
          </p>
        )}
        {refusal !== undefined && (
          <InlineStatus tone={refusalTone(refusal)} density="compact" className={cn('p-0', PLAIN_TEXT)}>
            {refusalMessage(refusal)}
          </InlineStatus>
        )}
        <ChecklistItemControls sessionId={sessionId} checklistId={checklistId} item={item} agentRunning={agentRunning} />
      </div>
    </li>
  )
}

/** A row re-renders only when its item revision, pending flag or refusal changes; `onTick` is stable. */
export const ChecklistRow = memo(
  ChecklistRowView,
  (a, b) =>
    a.item.rev === b.item.rev &&
    a.pending === b.pending &&
    a.refusal === b.refusal &&
    a.onTick === b.onTick &&
    a.sessionId === b.sessionId &&
    a.checklistId === b.checklistId &&
    a.agentRunning === b.agentRunning
)
