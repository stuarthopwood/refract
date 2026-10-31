import { useId } from 'react'
import type { ComponentProps, ComponentType, KeyboardEvent, Ref } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ActiveIndicatorBar } from '@/components/ActiveIndicatorBar'
import { COMPOSER_BUTTON_FOCUS_CLASS } from '@/features/chat/pickerShared'
import { CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { StateIcon } from './sessionDisplay'
import type { GroupWaitingState } from './sessionDisplay'

export const GROUP_HEADER_ACTIONS_WIDTH_PX = 80
export const GROUP_HEADER_ACTIONS_OFFSET_PX = 88

// Hidden at rest via opacity (stays in the Tab order); revealed on group hover/focus, own aria-expanded, and under (hover: none) (#567).
// `dark:hover:` / `aria-expanded:` fills beat the Button base's `dark:hover:bg-row-hover-bg`, which equals the selected row; the focus class restores a forced-colours outline.
export const HEADER_ACTION_BUTTON_CLASS = cn(
  'text-muted-foreground opacity-0 transition-opacity duration-150 motion-reduce:transition-none',
  'hover:bg-sidebar-border hover:text-foreground dark:hover:bg-sidebar-border aria-expanded:bg-sidebar-border',
  'group-hover/header:opacity-100 group-focus-within/header:opacity-100 aria-expanded:opacity-100 focus-visible:opacity-100',
  '[@media(hover:none)]:opacity-100',
  COMPOSER_BUTTON_FOCUS_CLASS
)

const GROUP_HEADER_ROW_BASE_CLASS = 'group/header flex items-center gap-1 px-1'
const GROUP_HEADER_ROW_FILL_CLASS =
  'rounded-md hover:bg-sidebar-accent has-[:focus-visible]:bg-sidebar-accent forced-colors:hover:outline forced-colors:hover:outline-1 forced-colors:hover:outline-[Highlight] forced-colors:has-[:focus-visible]:outline forced-colors:has-[:focus-visible]:outline-1 forced-colors:has-[:focus-visible]:outline-[Highlight]'

/** One rounded hover/keyboard-focus fill across a whole header row, buttons included (#1422). `plain` drops it while renaming. */
export function GroupHeaderRow({ plain, className, ...props }: ComponentProps<'div'> & { plain?: boolean }) {
  return <div {...props} className={cn(GROUP_HEADER_ROW_BASE_CLASS, !plain && GROUP_HEADER_ROW_FILL_CLASS, className)} />
}

// Shared trigger styling for the Repository and Archived headers so they cannot drift. `icon` is decorative;
// `tooltip` is also appended to the accessible name so screen readers get the status (#527, #528).
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
  containsOpenSession,
  color
}: {
  label: string
  count?: number
  title?: string
  icon?: ComponentType<{ 'aria-hidden'?: boolean; className?: string }>
  tooltip?: string
  triggerRef?: Ref<HTMLButtonElement>
  onDoubleClick?: () => void
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void
  marker?: GroupWaitingState | null
  /** This (closed) Group contains the currently visible Session. */
  containsOpenSession?: boolean
  color?: string
}) {
  const pathId = useId()
  const describedByPath = tooltip && title
  // Marker status and "contains open session" extend the trigger's accessible name, like `tooltip` (no second aria-describedby).
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
      aria-describedby={describedByPath ? pathId : undefined}
      data-choice-item
      data-project-colored={color ? '' : undefined}
      style={color ? { color } : undefined}
      className="group/trigger relative flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 text-left text-sm font-medium text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
    >
      {/* #735 decision 22: the visible Session's group, while closed -- the existing
          selected cue (`SessionRow.tsx`'s own left-edge bar), no fill, reserved for hover.
          Issue #1122: the shared `ActiveIndicatorBar` replaces this row's own hand-copied
          rounded-pill/inset span. */}
      {containsOpenSession && <ActiveIndicatorBar />}
      {/* Gate round 1 fix (High, code-reviewer): keying this off `data-state` broke the moment
          the whole trigger became a Tooltip's child too -- Radix's `TooltipTrigger` spreads its
          OWN `data-state` ('closed'/'delayed-open'/'instant-open') onto this element AFTER
          `CollapsibleTrigger` sets its own ('open'/'closed'), so `[data-state=open]` never
          matched on any repository header (the arrow stayed closed-looking even when the group
          was open). `aria-expanded` is set only by Collapsible and untouched by Tooltip, so
          keying off it instead is immune to this. */}
      <ChevronRightIcon aria-hidden className="size-4 shrink-0 transition-transform group-aria-expanded/trigger:rotate-90" />
      {Icon && <Icon aria-hidden className="size-4 shrink-0" />}
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
