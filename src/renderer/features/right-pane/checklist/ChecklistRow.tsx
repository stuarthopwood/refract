import { LoaderCircleIcon } from 'lucide-react'
import { useId } from 'react'
import { CHECKBOX_BOX_ONLY_CLASS, CheckboxIndicator, CheckboxItem } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import type { ItemRefusal } from '@/state/checklist-store'
import type { ChecklistItem } from '../../../../shared/checklist'
import { refusalMessage } from './checklist-refusal'
import { CHECKLIST_STATUS_GLYPH } from './checklist-status'
import { needsValueToTick } from './checklist-tick'

interface ChecklistRowProps {
  item: ChecklistItem
  /** A `checklist.mutate` for this item is in flight. */
  pending: boolean
  refusal?: ItemRefusal
  onTick: () => void
}

const PLAIN_TEXT = 'whitespace-pre-wrap break-words'

/** One checklist item: tick, text, status with icon and word, who completed it, its value, and why a tick was refused. */
export function ChecklistRow({ item, pending, refusal, onTick }: ChecklistRowProps) {
  const id = useId()
  const textId = `${id}-text`
  const reasonId = `${id}-reason`
  const complete = item.status === 'complete'
  const needsValue = needsValueToTick(item)
  const { Icon, className, word, showWord } = CHECKLIST_STATUS_GLYPH[item.status]
  const completedBy = complete ? (item.completedBy ?? item.updatedBy) : undefined

  return (
    <li
      data-slot="checklist-row"
      data-checklist-item={item.id}
      aria-current={item.status === 'next' ? 'step' : undefined}
      className="flex items-start gap-2 border-b border-border px-2 py-2 text-sm last:border-b-0"
    >
      <span className="grid size-6 shrink-0 place-items-center">
        <CheckboxItem
          checked={complete}
          // Never `disabled`: that would drop focus to the body while the result is pending. The store ignores a tick while pending or still missing its value.
          aria-disabled={pending || needsValue}
          aria-busy={pending}
          aria-labelledby={textId}
          aria-describedby={needsValue ? reasonId : undefined}
          onCheckedChange={() => onTick()}
          className={cn(CHECKBOX_BOX_ONLY_CLASS, 'relative after:absolute after:-inset-1 after:content-[""]')}
        >
          {pending ? <LoaderCircleIcon aria-hidden className="size-3 animate-spin motion-reduce:animate-none" /> : <CheckboxIndicator className="[&_svg]:size-3" />}
        </CheckboxItem>
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span id={textId} className={PLAIN_TEXT}>
          {item.text}
        </span>
        <span className={cn('inline-flex items-center gap-1 text-xs', className)}>
          <Icon aria-hidden className="size-3.5 shrink-0" />
          <span className={showWord ? undefined : 'sr-only'}>{word}</span>
        </span>
        {completedBy !== undefined && <span className="text-xs text-muted-foreground">Completed by {completedBy === 'agent' ? 'the agent' : 'you'}</span>}
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
          <p role="alert" className={cn('text-xs text-severity-error', PLAIN_TEXT)}>
            {refusalMessage(refusal)}
          </p>
        )}
      </div>
    </li>
  )
}
