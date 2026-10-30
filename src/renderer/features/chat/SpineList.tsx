// Vertical guide rail down the left edge of a related-rows list; the group header draws the first node.
// State is carried by each row's icon plus word, never the spine (#565).
import * as React from 'react'
import { cn } from '@/lib/utils'

// Hosts zero their CollapsedLine content class to this, since the list supplies the geometry.
export const SPINE_HOST_CONTENT_CLASS = 'space-y-0 p-0'

export interface SpineListProps {
  /** `<li>` rows; member icons keep their own `px-2` for the gap right of the line. */
  children: React.ReactNode
  /** Row gap: 4px `member` (default) or 8px `stage` (between stages). */
  gap?: 'member' | 'stage'
  className?: string
}

export function SpineList({ children, gap = 'member', className }: SpineListProps) {
  return (
    // aria-live off: a member arriving in an expanded running group must not be announced individually.
    <ol
      aria-live="off"
      className={cn('ml-4 border-l border-divider pt-1', gap === 'stage' ? 'space-y-2' : 'space-y-1', className)}
    >
      {children}
    </ol>
  )
}

/** One `<li>` in a `SpineList`. `isNew` is read once on first render so a mid-fade re-render can't cut the animation short. */
export function SpineItem({ isNew, children, className }: { isNew: boolean; children: React.ReactNode; className?: string }) {
  const [fadesIn] = React.useState(isNew)
  return <li className={cn(fadesIn && 'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150', className)}>{children}</li>
}
