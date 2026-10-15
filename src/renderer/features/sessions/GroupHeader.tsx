import { useId } from 'react'
import type { ComponentType, KeyboardEvent, Ref } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// Gate round 3 fix (Low, code-reviewer): named so it reads as "the width of the row's own
// action buttons", not a bare magic number -- two 28px `icon-sm` buttons (the "+" quick-create
// and the branch picker) plus the 22px "..." menu button, their `gap-1` spacing, and the row's
// own trailing padding: (28 + 28 + 22) + (3 * 4) + 4 = 94px, rounded up with a small margin.
const GROUP_HEADER_ACTIONS_OFFSET_PX = 104

// Issue #527 decision 1: the one trigger styling (chevron, size, case, padding) shared by a
// Repository header and the cross-repository Archived header below, so the two headers cannot
// drift apart from each other again. A Repository header passes its own rename support; the
// Archived header (no rename, no actions) passes only a label.
// Issue #528: an optional leading `icon` slot (aria-hidden, decorative) plus `tooltip` text --
// when a Repository header's icon alone carries NEW information (remote vs local-only) not
// otherwise visible, `tooltip` both shows a Radix tooltip on hover/focus AND is appended to the
// trigger's own accessible name, so the status is never conveyed by the icon's shape alone to a
// screen reader that does not surface hover tooltips. The Archived header passes no tooltip:
// its icon is pure decoration, the visible "ARCHIVED (N)" label already says everything.
export function GroupHeaderTrigger({
  label,
  title,
  icon: Icon,
  tooltip,
  triggerRef,
  onDoubleClick,
  onKeyDown
}: {
  label: string
  title?: string
  icon?: ComponentType<{ 'aria-hidden'?: boolean; className?: string }>
  tooltip?: string
  triggerRef?: Ref<HTMLButtonElement>
  onDoubleClick?: () => void
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void
}) {
  const pathId = useId()
  // Gate round 2 fix (Low, a11y-auditor): dropping the native `title` below (so it never shows
  // a second overlapping tooltip) also dropped the repository's path from assistive tech
  // entirely, since that span was never focusable or read either way -- an `sr-only` span plus
  // `aria-describedby` restores it, only when there is a path to describe.
  const describedByPath = tooltip && title
  const trigger = (
    <CollapsibleTrigger
      ref={triggerRef}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      aria-label={tooltip ? `${label}, ${tooltip}` : undefined}
      // Gate round 1 fix (Low, a11y-auditor): without this, the Tooltip wrapper below adds its
      // own `aria-describedby` pointing at the SAME text `aria-label` above already carries, so
      // a screen reader would read the remote status twice for one hover/focus. Radix's Slot
      // merge lets this explicit prop win over the one Tooltip injects.
      aria-describedby={describedByPath ? pathId : undefined}
      className="group/trigger flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm font-medium text-sidebar-foreground/70 uppercase tracking-wide hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
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
      {describedByPath && (
        <span id={pathId} className="sr-only">
          {title}
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
          Gate round 2 fix (Medium, a11y-auditor): `sideOffset={104}` pushes it clear of the
          always-present "+"/branch-picker/"..." buttons immediately to the trigger's right --
          without it, the tooltip opened right on top of them, and Radix keeps hoverable content
          open while the pointer is over it, blocking a click on any of the three. */}
      <TooltipContent side="right" align="start" sideOffset={GROUP_HEADER_ACTIONS_OFFSET_PX}>
        {/* Gate round 2 fix (Medium, code-reviewer): `TooltipContent` is `inline-flex`, so a
            bare `<br/>` between two text nodes does not start a new line -- wrapping both lines
            in their own `flex-col` container does, and `break-all` keeps a long Windows path
            from overflowing the tooltip's own width. */}
        <div className="flex flex-col gap-0.5">
          <span>{tooltip}</span>
          {title && <span className="break-all">{title}</span>}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
