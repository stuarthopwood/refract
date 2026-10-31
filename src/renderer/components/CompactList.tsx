// The shared two-column compact list (ADR 0003) for narrow columns: a label with an optional muted
// caption under it, and a right-aligned value. Text wraps so nothing is hover-only; an item with a
// `title` gets a focusable row and tooltip. Rows are list items, never a grid that scrolls sideways.
import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { INSET_FOCUS_OUTLINE_CLASS } from '@/components/ui/focus-classes'
import { cn } from '@/lib/utils'

export interface CompactListItem {
  key: string
  label: string
  /** One muted line under the label. */
  caption?: string
  value: string
  /** Extra tooltip text; setting it makes the row keyboard-focusable. */
  title?: string
}

export function CompactList({ label, items, className, footer }: { label: string; items: CompactListItem[]; className?: string; footer?: ReactNode }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <ul aria-label={label} className="flex min-w-0 flex-col divide-y divide-border">
        {items.map((item) => {
          const row = (
            <li key={item.key} tabIndex={item.title ? 0 : undefined} className={cn('flex min-w-0 items-baseline justify-between gap-2 py-2 text-sm', item.title && INSET_FOCUS_OUTLINE_CLASS)}>
              <span className="flex min-w-0 flex-col">
                <span className="break-words">{item.label}</span>
                {item.caption && <span className="break-words text-xs text-muted-foreground">{item.caption}</span>}
              </span>
              <span className="max-w-[50%] shrink-0 break-words text-right tabular-nums text-muted-foreground">{item.value}</span>
            </li>
          )
          if (!item.title) return row
          return (
            <Tooltip key={item.key}>
              <TooltipTrigger asChild>{row}</TooltipTrigger>
              <TooltipContent>{item.title}</TooltipContent>
            </Tooltip>
          )
        })}
      </ul>
      {footer}
    </div>
  )
}
