import { useId } from 'react'
import type { ComponentType, KeyboardEvent, Ref } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { StateIcon } from './sessionDisplay'
import type { GroupWaitingState } from './sessionDisplay'

// #567 decision 6: named so it reads as "the width of the row's own action buttons", not a bare
// magic number -- three 24px `icon-xs` ghost buttons (RepositoryGroup.tsx's own "+" quick-
// create, branch picker, and "..." menu, replacing the previous mixed 28px/28px/22px sizes),
// the header's own `gap-1` between the trigger and each of them (3 real gaps, trigger-to-first
// and between each pair after it, 4px apiece): 3*24 + 3*4 = 84px, PLUS the header row's own
// trailing `px-1` PADDING (not a fourth gap) that closes the row out, 4px more, giving
// `sideOffset`'s own 88px (a tooltip sits OUTSIDE the trigger, past the actions AND that
// trailing padding, so it needs the full distance to the header's own right edge).
//
// Gate round 1 fix (High, three independent reviewers): `ArchivedGroup.tsx`'s own spacer is
// INSIDE its trigger's row, the same as the three action buttons it stands in for -- it must
// NOT also add the trailing px-1 padding a second time (that padding closes the row once, after
// the spacer or the real buttons, not after each). The previous single shared constant used here
// for both purposes double-counted that padding on the spacer (96px realised width against an
// 88px real Repository actions column), leaving Archived's own marker about 8px left of a
// Repository header's -- the exact #908 "Archived marker column" defect this change claimed,
// wrongly, to have fixed "by construction". `GROUP_HEADER_ACTIONS_WIDTH_PX` is the actions
// column alone (3*24 + 2*4 = 80, the real gaps BETWEEN three buttons, none trailing) for
// `ArchivedGroup.tsx`'s spacer; `GROUP_HEADER_ACTIONS_OFFSET_PX` (88, unchanged) stays the
// tooltip's own `sideOffset`, which legitimately needs the trailing padding too.
export const GROUP_HEADER_ACTIONS_WIDTH_PX = 80
export const GROUP_HEADER_ACTIONS_OFFSET_PX = 88

// Issue #527 decision 1: the one trigger styling (chevron, size, case, padding) shared by a
// Repository header and the cross-repository Archived header in ArchivedGroup.tsx, so the two headers cannot
// drift apart from each other again. A Repository header passes its own rename support; the
// Archived header (no rename, no actions) passes only a label.
// Issue #528: an optional leading `icon` slot (aria-hidden, decorative) plus `tooltip` text --
// when a Repository header's icon alone carries NEW information (remote vs local-only) not
// otherwise visible, `tooltip` both shows a Radix tooltip on hover/focus AND is appended to the
// trigger's own accessible name, so the status is never conveyed by the icon's shape alone to a
// screen reader that does not surface hover tooltips. The Archived header passes no tooltip:
// its icon is pure decoration, the visible "Archived" label plus its own count (decision 5)
// already says everything.
export function GroupHeaderTrigger({
  label,
  count,
  title,
  icon: Icon,
  tooltip,
  triggerRef,
  onDoubleClick,
  onKeyDown,
  marker,
  containsOpenSession
}: {
  label: string
  /** #567 decision 5: the Archived header's own count, shown as a separate `tabular-nums` span
   *  after `label` ("Archived" + "3"), never `Archived (N)` -- product-look-and-feel.md:27 bans
   *  brackets. Folded into the accessible name as "Archived, 3" by `extraNameParts` below,
   *  rather than a second `aria-describedby` region. A Repository header passes none. */
  count?: number
  title?: string
  icon?: ComponentType<{ 'aria-hidden'?: boolean; className?: string }>
  tooltip?: string
  triggerRef?: Ref<HTMLButtonElement>
  onDoubleClick?: () => void
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void
  /** #735 decision 21: the Waiting marker -- the most urgent state among this
   * (closed) Group's Sessions, or `null`/`undefined` for an open Group or one with nothing to
   * flag. */
  marker?: GroupWaitingState | null
  /** #735 decision 22: this (closed) Group contains the currently visible Session. */
  containsOpenSession?: boolean
}) {
  const pathId = useId()
  // Gate round 2 fix (Low, a11y-auditor): dropping the native `title` below (so it never shows
  // a second overlapping tooltip) also dropped the repository's path from assistive tech
  // entirely, since that span was never focusable or read either way -- an `sr-only` span plus
  // `aria-describedby` restores it, only when there is a path to describe.
  const describedByPath = tooltip && title
  // #735 decisions 21, 22: the marker's status word and "contains open session" both extend
  // the trigger's own accessible name, the same way `tooltip` already does -- combined into one
  // name, not read twice over by a second `aria-describedby` region.
  const extraNameParts = [
    count !== undefined ? String(count) : null,
    tooltip,
    marker?.label,
    containsOpenSession ? 'contains open session' : null
  ].filter((part): part is string => Boolean(part))
  const ariaLabel = extraNameParts.length > 0 ? `${label}, ${extraNameParts.join(', ')}` : undefined
  const trigger = (
    <CollapsibleTrigger
      ref={triggerRef}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      aria-label={ariaLabel}
      // Gate round 1 fix (Low, a11y-auditor): without this, the Tooltip wrapper below adds its
      // own `aria-describedby` pointing at the SAME text `aria-label` above already carries, so
      // a screen reader would read the remote status twice for one hover/focus. Radix's Slot
      // merge lets this explicit prop win over the one Tooltip injects.
      aria-describedby={describedByPath ? pathId : undefined}
      // Gate round 1 fix (Medium, architect ruling on decision 8): `gap-1`/`px-1` (was
      // `gap-1.5`/`px-1.5`, itself off-grid per decision 28) -- moves the Project icon's own
      // left edge to exactly 24px (4px container padding + 4px this padding + 12px chevron +
      // 4px gap), so `SessionRow.tsx`'s own `pl-6` status icon finally lines up under it.
      className="group/trigger relative flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 text-left text-xs font-medium text-muted-foreground hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
    >
      {/* #735 decision 22: the visible Session's group, while closed -- the existing
          selected cue (`SessionRow.tsx`'s own left-edge bar), no fill, reserved for hover. */}
      {containsOpenSession && (
        <span
          aria-hidden
          className="absolute inset-y-1 left-0 z-10 w-0.5 rounded-full bg-active-indicator forced-color-adjust-none forced-colors:bg-[Highlight]"
        />
      )}
      {/* Gate round 1 fix (High, code-reviewer): keying this off `data-state` broke the moment
          the whole trigger became a Tooltip's child too -- Radix's `TooltipTrigger` spreads its
          OWN `data-state` ('closed'/'delayed-open'/'instant-open') onto this element AFTER
          `CollapsibleTrigger` sets its own ('open'/'closed'), so `[data-state=open]` never
          matched on any repository header (the arrow stayed closed-looking even when the group
          was open). `aria-expanded` is set only by Collapsible and untouched by Tooltip, so
          keying off it instead is immune to this. */}
      <ChevronRightIcon aria-hidden className="size-3 shrink-0 transition-transform group-aria-expanded/trigger:rotate-90" />
      {Icon && <Icon aria-hidden className="size-3 shrink-0" />}
      <span className="truncate" title={tooltip ? undefined : title}>{label}</span>
      {/* #567 decision 5: a separate `tabular-nums` count, never `Archived (N)` in brackets. */}
      {count !== undefined && <span className="shrink-0 tabular-nums text-muted-foreground">{count}</span>}
      {describedByPath && (
        <span id={pathId} className="sr-only">
          {title}
        </span>
      )}
      {/* #735 decision 21: the Waiting marker -- lines up in one column next to the
          space the row's own header actions reserve (#567 decision 6). Unaffected by
          `containsOpenSession`'s bar above: that sits flush on the trigger's own left edge. */}
      {marker && (
        <span aria-hidden className="ml-auto flex shrink-0">
          <StateIcon status={marker.status} />
        </span>
      )}
    </CollapsibleTrigger>
  )
  if (!tooltip) return trigger
  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      {/* Gate round 1 fix (Medium, all four reviewers): the label span's own native `title` (the
          repository's absolute path) is dropped above whenever this Tooltip wraps the trigger,
          so the two tooltips never show at once -- the path moves in here instead, as a second
          line. `side="right"`: a full-width header's tooltip would otherwise open above it (the
          default `side="top"`) and cover the previous group's last row and its hover actions.
          Gate round 2 fix (Medium, a11y-auditor): `sideOffset={GROUP_HEADER_ACTIONS_OFFSET_PX}`
          pushes it clear of the "+"/branch-picker/"..." buttons immediately to the trigger's
          right once they are revealed (gate round 1 fix: they are hidden at rest, decision 6) --
          without it, the tooltip opened right on top of them, and Radix keeps hoverable content
          open while the pointer is over it, blocking a click on any of the three. */}
      <TooltipContent side="right" align="start" sideOffset={GROUP_HEADER_ACTIONS_OFFSET_PX}>
        {/* Gate round 2 fix (Medium, code-reviewer): `TooltipContent` is `inline-flex`, so a
            bare `<br/>` between two text nodes does not start a new line -- wrapping both lines
            in their own `flex-col` container does, and `break-all` keeps a long Windows path
            from overflowing the tooltip's own width. */}
        <div className="flex flex-col gap-1">
          <span>{tooltip}</span>
          {title && <span className="break-all">{title}</span>}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
