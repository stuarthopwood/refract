// Where a pull request sits in a stack (#1867, FR-008): a compact "Stack 2 of 3" badge for rows and headers.
import { LayersIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

interface StackBadgeProps {
  /** 1-based, bottom layer first. */
  position: number
  total: number
  className?: string
}

export function StackBadge({ position, total, className }: StackBadgeProps) {
  return (
    <Badge variant="outline" data-stack-badge className={className}>
      <LayersIcon aria-hidden />
      Stack {position} of {total}
    </Badge>
  )
}
