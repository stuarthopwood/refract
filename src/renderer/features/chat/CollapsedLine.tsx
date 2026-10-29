import * as React from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ClampedContent } from '@/components/ClampedContent'

// #565 decision 10: the label column -- row `px-2` (8px) + the icon slot (`size-4`, 16px) +
// `gap-2` (8px) = 32px -- is private to this file's own layout, so every consumer that wants a
// nested `Collapsible`'s own expanded body to start there (a solo group's body, a `SpineList`
// member's own body, a long notice's body) imports this constant rather than copying `pl-8` by
// hand; a future slot/gap change then only has one call site to update.
export const LABEL_COLUMN_CONTENT_CLASS = 'pl-8'

export interface CollapsedLineProps {
  /** Optional decoration rendered before the icon slot (an advisory row's `SourceTag`, #1041). */
  leading?: React.ReactNode
  /** Icon slot: the consumer picks a shape that differs by state (running spinner, check,
   * cross, warning triangle, ...) so a warning or error is never signalled by colour alone
   * (T080, WCAG 2.1 AA). */
  icon: React.ReactNode
  /** Spec 023 (FR-011, research Decision 8): supplementary tooltip text for the icon slot (a
   * tool row's raw tool id). Opens while the pointer hovers the icon, or while the row's own
   * focusable element matches `:focus-visible`; Escape dismisses it, it stays open while
   * hovered, and the icon adds no tab stop and stays hidden from assistive technology (never
   * the accessible name). Omit for no tooltip; output is then unchanged. */
  iconTooltip?: string
  /** Short label (tool name, "Thinking", "Asked user", a subagent's name, ...); omit for a
   * line whose `summary` already carries the whole text (e.g. a notice). */
  label?: React.ReactNode
  /** One-line summary that truncates with an ellipsis; omit for a line with nothing to summarise. */
  summary?: React.ReactNode
  /** Right-aligned status/duration slot. */
  meta?: React.ReactNode
  /** Gate round 6 fix (issue #941, item 1, MEDIUM): overrides the meta wrapper's own default
   * `shrink-0` -- gate round 5 changed that shared default to `min-w-0 shrink` directly, which
   * silently affected EVERY OTHER `CollapsedLine` caller with a `meta` (`ToolRow.tsx`,
   * `AdvisoryRow.tsx`, `RequestCard.tsx`, ...), not just the Stage/chain rows the fix was meant
   * for. The shared default is `shrink-0` again; only the Stage row and the chain header opt
   * into `min-w-0 shrink` via this prop. */
  metaClassName?: string
  /** Overrides the summary's default `text-muted-foreground` (e.g. a notice tinted by level). */
  summaryClassName?: string
  /** Gate round 3 fix (issue #941): the default summary slot is `flex-1 min-w-0` with a 0%
   * flex-basis -- when the row's OTHER fixed-width content (the label, `meta`) already fills
   * the available width with no free space left over, a 0%-basis flex-grow item is correctly
   * assigned exactly 0px, and `truncate`'s own `overflow:hidden` then shows nothing at all (a
   * one-agent Stage's own agent name, `SubagentChainRow.tsx`'s `soloAgentName`, vanished this
   * way). Opt-in: `shrink-0 max-w-[40%] truncate` instead, reserving a real minimum share of
   * the row regardless of the label's own length, at the cost of the summary no longer growing
   * to fill genuinely empty space the way the default behaviour does for every other caller. */
  summaryFixedWidth?: boolean
  /** Extra label classes; the label defaults to regular weight (400) with no colour (e.g. a failed call's own
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
  /** Issue #1008 item 2: a stable DOM id on whichever element actually receives focus (the
   * plain row `div` with no `children`, or the `CollapsibleTrigger` button with them) --
   * `ChainStageLine`'s own "Go to Stage N" jump button looks a Stage row up by this id
   * (`document.getElementById`, not a ref: the two components are siblings, not parent/child).
   * Omit for a row nothing ever needs to jump to. */
  id?: string
  className?: string
  contentClassName?: string
  /** #1236: clamp an expanded body to this many lines behind a Show more button (only shown when
   * the body overflows). Omit for an unclamped body. */
  clampLines?: number
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
    leading,
    icon,
    iconTooltip,
    label,
    summary,
    meta,
    metaClassName,
    summaryClassName,
    summaryFixedWidth,
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
    contentClassName,
    clampLines,
    id
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
  // Spec 023 Decision 8: Radix opens a tooltip only on its own trigger's focus, and the icon must
  // not become a tab stop, so the row's own focus-visible state drives `open` alongside hover.
  // `tooltipDismissed` keeps an Escape-dismissed tooltip closed until the next focus or hover.
  const [tooltipHovered, setTooltipHovered] = React.useState(false)
  const [rowFocusVisible, setRowFocusVisible] = React.useState(false)
  const [tooltipDismissed, setTooltipDismissed] = React.useState(false)
  // Gate fix: a long transcript has hundreds of tool rows, so the Radix tooltip is mounted only
  // once the row is armed (icon pointer enter or row focus); until then the icon is a plain span.
  const [tooltipArmed, setTooltipArmed] = React.useState(false)
  const tooltipOpen = iconTooltip !== undefined && !tooltipDismissed && (tooltipHovered || rowFocusVisible)
  const focusHandlers =
    iconTooltip === undefined
      ? undefined
      : {
          onFocus: (e: React.FocusEvent<HTMLElement>) => {
            if (e.target !== e.currentTarget) return
            setTooltipArmed(true)
            setTooltipDismissed(false)
            setRowFocusVisible(e.currentTarget.matches(':focus-visible'))
          },
          onBlur: (e: React.FocusEvent<HTMLElement>) => {
            if (e.target === e.currentTarget) setRowFocusVisible(false)
          }
        }

  const row = (
    <>
      {leading !== undefined && <span className="flex h-5 shrink-0 items-center">{leading}</span>}
      {/* #565 decision 7: 16px slot (icon is `size-4` (16px), centred within it) so
       * every node centres on the 4px grid; every label/summary/meta moves 2px right, evenly.
       * Gate round 1 (Main, D1): the row is `items-start` (not `items-center`), so this slot's
       * own height must match the label's 20px line box (`h-5`) for the icon to sit centred on
       * it rather than flush against the top. */}
      {iconTooltip === undefined ? (
        <span className="flex h-5 w-4 shrink-0 items-center justify-center">{icon}</span>
      ) : !tooltipArmed ? (
        // The first pointer enter arms the row and opens the tooltip in the same update, so the
        // first hover shows it; Radix's trigger then owns the pointer leave.
        <span
          aria-hidden="true"
          className="flex h-5 w-4 shrink-0 items-center justify-center"
          onPointerEnter={(event) => {
            // Radix's trigger ignores touch, so arming does too.
            if (event.pointerType === 'touch') return
            setTooltipArmed(true)
            setTooltipDismissed(false)
            setTooltipHovered(true)
          }}
        >
          {icon}
        </span>
      ) : (
        <Tooltip
          open={tooltipOpen}
          onOpenChange={(next) => {
            if (next) setTooltipDismissed(false)
            setTooltipHovered(next)
          }}
        >
          <TooltipTrigger asChild>
            <span aria-hidden="true" className="flex h-5 w-4 shrink-0 items-center justify-center">
              {icon}
            </span>
          </TooltipTrigger>
          <TooltipContent
            // An open readout card captures Escape at `window` first and stops it, so one Escape
            // closes the card and a second closes this tooltip; never both at once.
            onEscapeKeyDown={() => {
              setTooltipDismissed(true)
              setTooltipHovered(false)
            }}
          >
            {iconTooltip}
          </TooltipContent>
        </Tooltip>
      )}
      {label !== undefined && (
        // Gate round 5 fix (issue #941, item 1, HIGH): `min-w-16` moved OUT of this shared
        // base class -- every other `CollapsedLine` caller (tool rows, advisory rows, notices)
        // shared this exact span and was silently widened by a floor only the solo-Stage row
        // needed. Back to `min-w-0` here (still required so `truncate` can ever engage); the
        // Stage row passes its own `min-w-16` via `labelClassName`
        // (`SubagentChainRow.tsx`'s `successLabelClass` call site).
        <span data-slot="collapsed-line-label" className={cn('min-w-0 max-w-full truncate', labelClassName)} title={typeof label === 'string' ? label : undefined}>
          {label}
        </span>
      )}
      {summary !== undefined ? (
        <>
          <span
            className={cn(
              // Gate round 4 fix (issue #941, P4, HIGH): a fixed-width summary (a solo Stage's
              // own agent name) was `shrink-0`, so it NEVER gave up width at a narrow pane --
              // at 380-520px that left meta/chevron hugging it directly once nothing else had
              // any slack left to give. `min-w-0 shrink` (dropping `shrink-0`) lets it
              // genuinely shrink below its own content width under real pressure, while
              // `max-w-[40%]` still caps how much of the row it can claim either way.
              summaryFixedWidth ? 'min-w-0 shrink max-w-[40%] truncate' : 'min-w-0 flex-1',
              // Issue #997: `[overflow-wrap:anywhere]` (not `break-words`, which Tailwind maps
              // to `overflow-wrap: break-word` -- a word still spills past the edge once the
              // whole word is wider than the column, e.g. a long unbroken token/URL) is this
              // transcript's prevailing choice; the expanded detail `<p id={detailId}>` below
              // (same file) already uses it for the identical reason.
              summaryWrap || (wrapWhenOpen && actualOpen) ? '[overflow-wrap:anywhere] whitespace-normal' : 'truncate',
              summaryClassName ?? 'text-muted-foreground'
            )}
            title={summaryFixedWidth && typeof summary === 'string' ? summary : undefined}
          >
            {summary}
          </span>
          {summaryFixedWidth && (
            // Gate round 4 fix (issue #941, P4, HIGH): a fixed-width summary claims no free
            // space of its own (no `flex-1`), so without a genuine flexible spacer after it,
            // meta/chevron sat directly adjacent to a short summary with nothing between them
            // to absorb the pane's own slack. Scoped to the fixed-width case only -- the
            // default summary already IS `flex-1` and already does this job for every other
            // existing caller, which a second always-on spacer here would otherwise split
            // growth with and subtly shift.
            <span className="min-w-0 flex-1" />
          )}
        </>
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
        // removes the extra boundary that caused it. Gate round 6 fix (issue #941, item 1,
        // MEDIUM): the shared default is `shrink-0` again -- gate round 5's own `min-w-0
        // shrink` fix for the 240-319px Stage/chain chevron clip was applied directly to this
        // shared base, silently affecting every OTHER caller's own `meta` (`ToolRow.tsx`,
        // `AdvisoryRow.tsx`, `RequestCard.tsx`, ...) that never asked for it. `metaClassName`
        // (opt-in, passed only by the Stage row and the chain header) carries that fix now.
        <span className={cn('shrink-0 text-xs leading-5 text-muted-foreground tabular-nums', metaClassName)}>
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
        id={id}
        tabIndex={-1}
        {...focusHandlers}
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
          id={id}
          aria-label={triggerAriaLabel}
          aria-describedby={showDetail ? detailId : undefined}
          {...focusHandlers}
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
            <ChevronRightIcon className={cn('size-4 text-muted-foreground transition-transform', actualOpen && 'rotate-90')} />
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
      <CollapsibleContent className={cn('space-y-2 px-2 pb-2 pt-1', contentClassName)}>
        {clampLines !== undefined ? <ClampedContent maxHeight={`${clampLines}lh`}>{children}</ClampedContent> : children}
      </CollapsibleContent>
    </Collapsible>
  )
})
