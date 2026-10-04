import * as React from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { cn } from 'cn'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

export interface CollapsedLineProps {
  /** Icon slot: the consumer picks a shape that differs by state (running spinner, check,
   * cross, warning triangle, ...) so a warning or error is never signalled by colour alone
   * (T080, WCAG 2.1 AA). */
  icon: React.ReactNode
  /** Short label (tool name, "Thinking", "Asked user:", a subagent's name, ...); omit for a
   * line whose `summary` already carries the whole text (e.g. a notice). */
  label?: React.ReactNode
  /** One-line summary that truncates with an ellipsis; omit for a line with nothing to summarise. */
  summary?: React.ReactNode
  /** Right-aligned status/duration slot. */
  meta?: React.ReactNode
  /** Overrides the summary's default `text-muted-foreground` (e.g. a notice tinted by level). */
  summaryClassName?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultOpen?: boolean
  /** Expansion content; omit entirely for a line with nothing to expand (it then renders as a
   * plain, non-interactive row with no chevron and no trigger). */
  children?: React.ReactNode
  className?: string
  contentClassName?: string
}

// The one shared collapsed-line baseline every chat output kind builds on (T080, docs/DESIGN.md
// "Chat"): an icon slot, a label, a truncating one-line summary, a status/duration slot, and (if
// `children` is given) a `Collapsible` expansion. A new output kind should start here instead of
// growing its own one-off collapsed row.
export function CollapsedLine({
  icon,
  label,
  summary,
  meta,
  summaryClassName,
  open,
  onOpenChange,
  defaultOpen,
  children,
  className,
  contentClassName
}: CollapsedLineProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false)
  const isControlled = open !== undefined
  const actualOpen = isControlled ? open : uncontrolledOpen
  const setOpen = onOpenChange ?? setUncontrolledOpen

  const row = (
    <>
      <span className="flex size-3.5 shrink-0 items-center justify-center">{icon}</span>
      {label !== undefined && <span className="shrink-0 font-medium">{label}</span>}
      {summary !== undefined && <span className={cn('min-w-0 flex-1 truncate', summaryClassName ?? 'text-muted-foreground')}>{summary}</span>}
      {meta !== undefined && <span className="shrink-0 text-xs text-muted-foreground">{meta}</span>}
    </>
  )

  if (children === undefined) {
    return <div className={cn('flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-sm', className)}>{row}</div>
  }

  return (
    <Collapsible
      open={actualOpen}
      onOpenChange={setOpen}
      className={cn('rounded-md border border-transparent hover:border-border', className)}
    >
      {/* Square choice items (docs/DESIGN.md "Look and feel"): only what's actually adjacent gets
       * square treatment -- once open, the content panel sits flush against this trigger's own
       * bottom edge, so its bottom corners go square instead of keeping a rounded highlight that
       * reads as a disconnected pill floating above the content. */}
      <CollapsibleTrigger
        className={cn(
          'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          actualOpen && 'rounded-b-none'
        )}
      >
        {row}
        <ChevronRightIcon className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', actualOpen && 'rotate-90')} />
      </CollapsibleTrigger>
      <CollapsibleContent className={cn('space-y-2 px-2 pb-2 pt-1', contentClassName)}>{children}</CollapsibleContent>
    </Collapsible>
  )
}
