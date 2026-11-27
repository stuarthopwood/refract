// A borderless fork glyph and the agent count on a Stage header that runs several agents at once (#1927, #2318, FR-175).
import { GitForkIcon } from 'lucide-react'

export function parallelBadgeText(count: number): string {
  return String(count)
}

export function parallelBadgeName(count: number): string {
  return `${count} agents in parallel`
}

export function ParallelBadge({ count }: { count: number }) {
  if (count < 2) return null
  return (
    <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums text-muted-foreground" title={parallelBadgeName(count)} data-parallel-badge>
      <GitForkIcon aria-hidden className="size-3 rotate-90" />
      {/* The visible text is the bare count; the screen-reader name says what is parallel. */}
      <span aria-hidden="true">{parallelBadgeText(count)}</span>
      <span className="sr-only">{parallelBadgeName(count)}</span>
    </span>
  )
}
