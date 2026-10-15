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
  /** Lets the summary wrap across lines instead of truncating with an ellipsis (#492): opt-in,
   * because the chat's own rows are deliberately one-line, but a narrow side panel (the
   * Subagents panel) needs a long path or paragraph visible instead of losing its useful tail. */
  summaryWrap?: boolean
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
// growing its own one-off collapsed row. Forwards a ref to whichever element can actually receive
// focus (the plain row `div` with no `children`, or the `CollapsibleTrigger` button with them) --
// gate round 2 (D17): the sole focus target `ResolvedRequestSummary`/`AskQuestionRow` hand focus
// to once the Ask card's own resolution replaces it (`ask-focus-intent.ts`).
export const CollapsedLine = React.forwardRef<HTMLElement, CollapsedLineProps>(function CollapsedLine(
  {
    icon,
    label,
    summary,
    meta,
    summaryClassName,
    summaryWrap,
    open,
    onOpenChange,
    defaultOpen,
    children,
    className,
    contentClassName
  },
  ref
) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false)
  const isControlled = open !== undefined
  const actualOpen = isControlled ? open : uncontrolledOpen
  const setOpen = onOpenChange ?? setUncontrolledOpen

  const row = (
    <>
      <span className="flex size-3.5 shrink-0 items-center justify-center">{icon}</span>
      {label !== undefined && <span className="shrink-0 font-medium">{label}</span>}
      {summary !== undefined && (
        <span
          className={cn('min-w-0 flex-1', summaryWrap ? 'break-words whitespace-normal' : 'truncate', summaryClassName ?? 'text-muted-foreground')}
        >
          {summary}
        </span>
      )}
      {meta !== undefined && (
        <>
          {/* Gate round 3 (architect M-3/code review): without this, a screen reader runs the
           * summary straight into the meta slot with no separator ("...and 1 more Answered"),
           * which can sound like part of the question's own text rather than a status word. Not
           * whitespace-only, so it survives collapsing. */}
          <span className="sr-only">, </span>
          <span className="shrink-0 text-xs text-muted-foreground">{meta}</span>
        </>
      )}
    </>
  )

  if (children === undefined) {
    return (
      <div
        ref={ref as React.Ref<HTMLDivElement>}
        tabIndex={-1}
        // Gate round 3 (architect L-d): an inset `outline` (not a `ring`/box-shadow) so this row
        // still shows a focus indicator in forced-colours mode, matching the trigger below.
        className={cn('flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring', className)}
      >
        {row}
      </div>
    )
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
        ref={ref as React.Ref<HTMLButtonElement>}
        className={cn(
          // Gate round 3 (architect M-1, unanimous): this trigger sits inside
          // `MessageScrollerItem`'s own `content-visibility:auto` (`message-scroller.tsx`), which
          // establishes paint containment with no padding -- an outward `outline-offset-2` (the
          // shadcn default) draws OUTSIDE this element's own box and was very likely clipped by
          // that containment. `-2px` draws the ring INSIDE instead, matching the plain row above.
          'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
          actualOpen && 'rounded-b-none'
        )}
      >
        {row}
        <ChevronRightIcon className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', actualOpen && 'rotate-90')} />
      </CollapsibleTrigger>
      <CollapsibleContent className={cn('space-y-2 px-2 pb-2 pt-1', contentClassName)}>{children}</CollapsibleContent>
    </Collapsible>
  )
})
