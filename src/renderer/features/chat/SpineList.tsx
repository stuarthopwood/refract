// Shared spine geometry (issue #565 "guide rails", steered in by Stuart's #565 decision while
// building #563): a neutral 1px `border-divider` vertical line down the left edge of a list of
// related rows, hanging visually from the group's own header icon (the header draws that icon
// itself, as the spine's first node -- this component only ever renders the member list below
// it). Never animates; no decorative disc or mask behind any row's own icon -- state is carried
// by each row's icon plus word, never by the spine itself (`aria-hidden` is unnecessary: the
// line is a CSS border, not a DOM node assistive tech would ever read). First built here for
// issue #563's Stage group member rows and the Subagent chain's own stage-to-stage list; #565
// extends it to tool-group and thought-run spines without changing this file.
import * as React from 'react'
import { cn } from 'cn'

// #565 decision 8/11: once a `Collapsible`'s own content is a `SpineList`, the sole geometry in
// play is the list's own `ml-4`/`pt-1` -- every host zeroes its `CollapsedLine`'s own
// `contentClassName` to this value rather than copying the literal string by hand.
export const SPINE_HOST_CONTENT_CLASS = 'space-y-0 p-0'

export interface SpineListProps {
  /** `<li>` rows (or elements that render their own `<li>`); member icons keep their OWN `px-2`
   * from `CollapsedLine`'s trigger, giving an 8px gap to the right of the line (#565 decision 8). */
  children: React.ReactNode
  /** Row gap: 4px (`space-y-1`, the default -- "between members") or 8px (`space-y-2` --
   * "between stages", the Subagent chain's own stage-to-stage list). */
  gap?: 'member' | 'stage'
  className?: string
}

export function SpineList({ children, gap = 'member', className }: SpineListProps) {
  return (
    // #565 decision 8: `ml-4` sits the line clear of the parent header's own icon column,
    // `pt-1` (not `pl-2`) gives the first member row's top breathing room -- members keep their
    // own `px-2` (from `CollapsedLine`'s trigger) for the 8px gap right of the line. Decision 23
    // / M9: a member arriving in an expanded RUNNING group must not be announced individually.
    <ol
      aria-live="off"
      className={cn('ml-4 border-l border-divider pt-1', gap === 'stage' ? 'space-y-2' : 'space-y-1', className)}
    >
      {children}
    </ol>
  )
}
