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

export interface SpineListProps {
  /** `<li>` rows (or elements that render their own `<li>`); member icons land 8px right of the
   * spine via this component's own `pl-2` (never directly on the line). */
  children: React.ReactNode
  /** Row gap: 4px (`space-y-1`, the default -- "between members") or 8px (`space-y-2` --
   * "between stages", the Subagent chain's own stage-to-stage list). */
  gap?: 'member' | 'stage'
  className?: string
}

export function SpineList({ children, gap = 'member', className }: SpineListProps) {
  return (
    <ol className={cn('border-l border-divider pl-2', gap === 'stage' ? 'space-y-2' : 'space-y-1', className)}>
      {children}
    </ol>
  )
}
