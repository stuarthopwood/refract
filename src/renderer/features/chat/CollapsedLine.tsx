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
  /** Overrides the label's default `font-medium` with no colour (e.g. a failed call's own
   * label and icon render in the error colour, #570 decision 4; the target stays muted). */
  labelClassName?: string
  /** Lets the summary wrap across lines instead of truncating with an ellipsis (#492): opt-in
   * while collapsed, because the chat's own rows are deliberately one-line and a narrow side
   * panel (the Subagents panel) needs a long path or paragraph visible instead of losing its
   * useful tail. Collapsed rows otherwise keep truncating regardless of this prop, for fast
   * scanning; `wrapWhenOpen` below is the separate, opt-in control for wrapping once expanded. */
  summaryWrap?: boolean
  /** Gate round 1 (code-reviewer High, H4): `summaryWrap || actualOpen` made EVERY
   * `CollapsedLine` wrap once expanded, including callers that never asked for it
   * (`AgentMessageRow`, `AdvisoryRow`, `RequestCard`, `NoticeRow`, `ThoughtRunRow`), producing
   * duplicate/jumpy text as their own already-expanded content repeated the now-wrapped summary.
   * Opt-in: only `ToolCallRow` and the solo branch of `ToolGroupRow` (#632's own "wrap instead
   * of truncate once expanded" fix) pass this; every other caller keeps truncating collapsed
   * and whatever its own expanded body already shows, unaffected by `actualOpen`. */
  wrapWhenOpen?: boolean
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
  /** #570 decisions 6/9: a failed tool call's own Error line, rendered as a `<p>` sibling of the
   * trigger -- inside the `Collapsible` root, outside `CollapsibleContent` and the button --
   * aligned to the label column (`pl-8 pr-2`). Linked to the trigger via `aria-describedby`.
   * Ignored when `children` is omitted (no trigger to describe). */
  detail?: React.ReactNode
  /** #570 decision 9: a multi-call group's own header shows its latest failed member's Error
   * line only while COLLAPSED (replaced by each failed member's own line once expanded); a solo
   * call's or a member's own Error line has no such condition and stays visible either way.
   * Opt-in per caller, since most `detail` callers want it unconditionally. */
  hideDetailWhenOpen?: boolean
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
    labelClassName,
    summaryWrap,
    wrapWhenOpen,
    open,
    onOpenChange,
    defaultOpen,
    triggerAriaLabel,
    action,
    detail,
    hideDetailWhenOpen,
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
  const detailId = React.useId()
  // Gate round 2 (G909A11y/G909Arch N6): a multi-call group's own Error line used to unmount
  // entirely on expand and remount on re-collapse -- the remount is a genuine DOM insertion
  // inside the transcript's `role="log"` region, so a user's OWN collapse re-announced an
  // already-known failure as if it were new (decision 15 wants exactly one announcement per
  // failure, not one per toggle). Fixed: the `<p>` stays MOUNTED for as long as `detail` itself
  // is defined (a hidden member's own line also attaches/detaches rows elsewhere already, so
  // this is never rendered for a row with no failure at all); only its visibility toggles via
  // the native `hidden` attribute, which removes it from the accessibility tree without an
  // actual node removal/insertion for Chromium's own live-region mutation detection to catch.
  const detailMounted = detail !== undefined
  const detailVisuallyHidden = hideDetailWhenOpen && actualOpen
  const showDetail = detailMounted && !detailVisuallyHidden

  const row = (
    <>
      {/* #565 decision 7: 16px slot (icon itself stays 14px, `size-3.5`, centred within it) so
       * every node centres on the 4px grid; every label/summary/meta moves 2px right, evenly.
       * Gate round 1 (Main, D1): the row is `items-start` (not `items-center`), so this slot's
       * own height must match the label's 20px line box (`h-5`) for the icon to sit centred on
       * it rather than flush against the top. */}
      <span className="flex h-5 w-4 shrink-0 items-center justify-center">{icon}</span>
      {label !== undefined && (
        <span className={cn('min-w-0 max-w-full truncate font-medium', labelClassName)} title={typeof label === 'string' ? label : undefined}>
          {label}
        </span>
      )}
      {summary !== undefined ? (
        <span
          className={cn(
            'min-w-0 flex-1',
            summaryWrap || (wrapWhenOpen && actualOpen) ? 'break-words whitespace-normal' : 'truncate',
            summaryClassName ?? 'text-muted-foreground'
          )}
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
        // Gate round 2 (G909Arch/Main): the separator used to be its own top-level sibling span
        // between the summary and the meta span; Chromium's own accessible-name-from-content
        // algorithm inserts a space between EVERY sibling node it concatenates, independent of
        // the separator's own text -- with the summary's own text ending in no whitespace of its
        // own, that produced a doubled space before the comma ("...+ 2 others , 1 failed"). Nesting
        // the separator INSIDE the meta span (one sibling boundary with the summary, not two)
        // removes the extra boundary that caused it.
        <span className="shrink-0 text-xs leading-5 text-muted-foreground tabular-nums">
          {/* Gate round 3 (architect M-3/code review): without this, a screen reader runs the
           * summary straight into the meta slot with no separator ("...and 1 more Answered"),
           * which can sound like part of the question's own text rather than a status word. Not
           * whitespace-only, so it survives collapsing. */}
          <span className="sr-only">, </span>
          {/* #565 decision 33: `tabular-nums` keeps a duration's digits aligned down a Spine. */}
          {meta}
        </span>
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
        className={cn('flex min-w-0 items-start gap-2 rounded-md px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring', className)}
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
      <div className="flex items-start gap-1">
        <CollapsibleTrigger
          ref={ref as React.Ref<HTMLButtonElement>}
          aria-label={triggerAriaLabel}
          aria-describedby={showDetail ? detailId : undefined}
          className={cn(
            // Gate round 3 (architect M-1, unanimous): this trigger sits inside
            // `MessageScrollerItem`'s own `content-visibility:auto` (`message-scroller.tsx`),
            // which establishes paint containment with no padding -- an outward
            // `outline-offset-2` (the shadcn default) draws OUTSIDE this element's own box and
            // was very likely clipped by that containment. `-2px` draws the ring INSIDE instead,
            // matching the plain row above.
            'flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring'
          )}
        >
          {row}
          <span className="flex h-5 shrink-0 items-center">
            <ChevronRightIcon className={cn('size-3.5 text-muted-foreground transition-transform', actualOpen && 'rotate-90')} />
          </span>
        </CollapsibleTrigger>
        {/* Sibling of the trigger, never nested inside it -- a `<button>` cannot nest inside
         * another interactive trigger (#563 remediation, round 2). Stays in this always-mounted
         * header row, reachable while collapsed (never inside `CollapsibleContent`). */}
        {action}
      </div>
      {detailMounted && (
        // #570 decisions 6-8: app font (a message, not code), text-xs, clamped at two lines,
        // no tint/border/box; plain text node, no markup or links. `dir="auto"` (gate round 1,
        // security Low): tool output may legitimately contain RTL text (a path or message in
        // another script); letting the browser infer direction from the first strong character
        // per element, rather than inheriting the page's own LTR, keeps that text readable
        // without giving a bidi-override character (already stripped in `errorLine()`) anywhere
        // to hide behind.
        <p
          id={detailId}
          dir="auto"
          // Gate round 2 (G909Arch N2): `dir="auto"` lets the browser infer direction from the
          // first strong character, which can right-align the WHOLE line (including the `pl-8`
          // label-column gutter) when the error text happens to start RTL -- `text-left` pins
          // the text's own alignment to the label column regardless of its inferred direction.
          //
          // Gate round 2 (G909A11y/G909Arch N6): `hidden` (not a conditional unmount) while a
          // multi-call group is expanded, so the node stays in the DOM across every collapse and
          // re-announcing an already-known failure on the user's own re-collapse (see
          // `detailMounted`'s own comment above).
          hidden={detailVisuallyHidden}
          className={cn(LABEL_COLUMN_CONTENT_CLASS, 'pr-2 line-clamp-2 text-left text-xs text-severity-error [overflow-wrap:anywhere]')}
        >
          {detail}
        </p>
      )}
      <CollapsibleContent className={cn('space-y-2 px-2 pb-2 pt-1', contentClassName)}>{children}</CollapsibleContent>
    </Collapsible>
  )
})
