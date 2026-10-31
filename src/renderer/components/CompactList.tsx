// The shared two-column compact list (ADR 0003) for narrow columns: a label (truncated, full text
// in a tooltip) with an optional muted caption under it, and a right-aligned value. Rows are list
// items, never a grid that scrolls sideways.
import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface CompactListItem {
  key: string
  label: string
  /** One muted line under the label. */
  caption?: string
  value: string
  /** Full text for the tooltip when the label or value is truncated; defaults to label and value. */
  title?: string
}

export function CompactList({ label, items, className, footer }: { label: string; items: CompactListItem[]; className?: string; footer?: ReactNode }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <ul aria-label={label} className="flex min-w-0 flex-col divide-y divide-border">
        {items.map((item) => (
          <Tooltip key={item.key}>
            <TooltipTrigger asChild>
              <li className="flex min-w-0 items-baseline justify-between gap-2 py-2 text-sm">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{item.label}</span>
                  {item.caption && <span className="truncate text-xs text-muted-foreground">{item.caption}</span>}
                </span>
                <span className="max-w-[50%] shrink-0 truncate tabular-nums text-muted-foreground">{item.value}</span>
              </li>
            </TooltipTrigger>
            <TooltipContent>{item.title ?? `${item.label}: ${item.value}`}</TooltipContent>
          </Tooltip>
        ))}
      </ul>
      {footer}
    </div>
  )
}
