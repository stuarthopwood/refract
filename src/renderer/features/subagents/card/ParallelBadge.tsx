// "N parallel" with a fork glyph on a Stage header that runs several agents at once (#1927, FR-147).
import { GitForkIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

export function parallelBadgeText(count: number): string {
  return `${count} parallel`
}

export function parallelBadgeName(count: number): string {
  return `${count} agents in parallel`
}

export function ParallelBadge({ count }: { count: number }) {
  if (count < 2) return null
  return (
    <Badge variant="outline" data-parallel-badge>
      <GitForkIcon aria-hidden className="size-3" />
      {/* The visible text is the short form; the screen-reader name says what is parallel. */}
      <span aria-hidden="true">{parallelBadgeText(count)}</span>
      <span className="sr-only">{parallelBadgeName(count)}</span>
    </Badge>
  )
}
