// Vertical guide rail down the left edge of a related-rows list; the group header draws the first node.
// State is carried by each row's icon plus word, never the spine (#565).
import * as React from 'react'
import { cn } from '@/lib/utils'

// Hosts zero their CollapsedLine content class to this, since the list supplies the geometry.
export const SPINE_HOST_CONTENT_CLASS = 'space-y-0 p-0'

// Elbow ticks are in the item, not the list, so each `SpineItem` reads this from its nearest `SpineList`.
const SpineElbowsContext = React.createContext(false)

export interface SpineListProps {
  /** `<li>` rows; a row's own `px-2` leaves its icon 8px right of the line. */
  children: React.ReactNode
  /** Row gap: 4px `member` (default) or 8px `stage` (between stages). */
  gap?: 'member' | 'stage'
  /** Opt-in: each row gets a short horizontal tick from the rail into its `h-5` icon line (the `px-2` gap). */
  elbows?: boolean
  className?: string
}

export function SpineList({ children, gap = 'member', elbows = false, className }: SpineListProps) {
  return (
    // aria-live off: a member arriving in an expanded running group must not be announced individually.
    <ol
      aria-live="off"
      className={cn('ml-4 border-l border-divider pt-1', gap === 'stage' ? 'space-y-2' : 'space-y-1', className)}
    >
      <SpineElbowsContext.Provider value={elbows}>{children}</SpineElbowsContext.Provider>
    </ol>
  )
}

/** One `<li>` in a `SpineList`. `isNew` is read once on first render so a mid-fade re-render can't cut the animation short. */
export function SpineItem({ isNew, children, className }: { isNew: boolean; children: React.ReactNode; className?: string }) {
  const [fadesIn] = React.useState(isNew)
  const elbows = React.useContext(SpineElbowsContext)
  return (
    <li className={cn(elbows && 'relative', fadesIn && 'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150', className)}>
      {elbows && (
        // A border, not a background, so forced-colors keeps it; the h-5 box centres it on the row's icon box.
        <span aria-hidden="true" className="pointer-events-none absolute left-0 top-0 flex h-5 w-2 items-center">
          <span className="w-full border-t border-divider" />
        </span>
      )}
      {children}
    </li>
  )
}
