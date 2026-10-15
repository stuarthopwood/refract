import * as React from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { cn } from 'cn'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

// #565 decision 10: the label column -- row `px-2` (8px) + the icon slot (`size-4`, 16px) +
// `gap-2` (8px) = 32px -- is private to this file's own layout, so every consumer that wants a
// nested `Collapsible`'s own expanded body to start there (a solo group's body, a `SpineList`
// member's own body, a long notice's body) imports this constant rather than copying `pl-8` by
// hand; a future slot/gap change then only has one call site to update.
export const LABEL_COLUMN_CONTENT_CLASS = 'pl-8'

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
  /** Accessible name applied directly to the `CollapsibleTrigger` (e.g. "Stage 1 of 3, 4 agents,
   * 3 finished, 1 failed"): unlike an sr-only span inside `children`, this stays reachable while
   * collapsed -- Radix unmounts `CollapsibleContent` when closed, so a label placed there is
   * invisible to assistive tech for the common collapsed/history case. Ignored when `children`
   * is omitted (no trigger is rendered). */
  triggerAriaLabel?: string
  /** An action control (e.g. a "Show subagents panel" icon button) rendered as a SIBLING of the
   * `CollapsibleTrigger`, never nested inside it -- a `<button>` cannot nest inside another
   * interactive trigger. Stays in the always-mounted header row, reachable while collapsed.
   * Ignored when `children` is omitted. */
  action?: React.ReactNode
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
    triggerAriaLabel,
    action,
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
      {/* #565 decision 7: 16px slot (icon itself stays 14px, `size-3.5`, centred within it) so
       * every node centres on the 4px grid; every label/summary/meta moves 2px right, evenly. */}
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      {label !== undefined && (
        <span className="min-w-0 max-w-full truncate font-medium" title={typeof label === 'string' ? label : undefined}>
          {label}
        </span>
      )}
      {summary !== undefined ? (
        <span
          className={cn('min-w-0 flex-1', summaryWrap ? 'break-words whitespace-normal' : 'truncate', summaryClassName ?? 'text-muted-foreground')}
        >
          {summary}
        </span>
      ) : (
        // No summary (e.g. a plain member row inside a `SpineList`): a spacer still pushes
        // meta/chevron to the far right so they line up with the header row's own trailing edge
        // (#565 decision 11) instead of hugging the label.
        <span className="min-w-0 flex-1" />
      )}
      {meta !== undefined && (
        <>
          {/* Gate round 3 (architect M-3/code review): without this, a screen reader runs the
           * summary straight into the meta slot with no separator ("...and 1 more Answered"),
           * which can sound like part of the question's own text rather than a status word. Not
           * whitespace-only, so it survives collapsing. */}
          <span className="sr-only">, </span>
          {/* #565 decision 33: `tabular-nums` keeps a duration's digits aligned down a Spine. */}
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{meta}</span>
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
    <Collapsible open={actualOpen} onOpenChange={setOpen} className={className}>
      {/* #565 decision 18: the root used to carry its own always-on `border border-transparent`
       * (hover swapping it to `hover:border-border`), a second box nested right inside whatever
       * ancestor box this row sits in -- the confirmed cause of #430's nested-box bug. Hover is
       * now only the trigger's own ghost `hover:bg-muted` below; the root carries no border. */}
      <div className="flex items-center gap-1">
        <CollapsibleTrigger
          ref={ref as React.Ref<HTMLButtonElement>}
          aria-label={triggerAriaLabel}
          className={cn(
            // Gate round 3 (architect M-1, unanimous): this trigger sits inside
            // `MessageScrollerItem`'s own `content-visibility:auto` (`message-scroller.tsx`),
            // which establishes paint containment with no padding -- an outward
            // `outline-offset-2` (the shadcn default) draws OUTSIDE this element's own box and
            // was very likely clipped by that containment. `-2px` draws the ring INSIDE instead,
            // matching the plain row above.
            'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring'
          )}
        >
          {row}
          <ChevronRightIcon className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', actualOpen && 'rotate-90')} />
        </CollapsibleTrigger>
        {/* Sibling of the trigger, never nested inside it -- a `<button>` cannot nest inside
         * another interactive trigger (#563 remediation, round 2). Stays in this always-mounted
         * header row, reachable while collapsed (never inside `CollapsibleContent`). */}
        {action}
      </div>
      <CollapsibleContent className={cn('space-y-2 px-2 pb-2 pt-1', contentClassName)}>{children}</CollapsibleContent>
    </Collapsible>
  )
})
