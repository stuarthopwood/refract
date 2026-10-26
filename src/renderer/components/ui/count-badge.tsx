// A small count pill pinned to the top-right corner of its (relatively positioned) parent, such
// as an icon-rail button (spec 024 FR-010). Over 9 reads "9+". The parent's accessible name must
// carry the count, so the pill itself is aria-hidden.
import { cn } from '@/lib/utils'

interface CountBadgeProps {
  value: number
  tone?: 'working' | 'neutral'
  className?: string
}

export function CountBadge({ value, tone = 'neutral', className }: CountBadgeProps) {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full border px-1 text-[10px] leading-none font-medium tabular-nums forced-colors:border-[CanvasText]',
        tone === 'working' ? 'border-transparent bg-state-working text-state-working-foreground' : 'border-border bg-muted text-foreground',
        className
      )}
    >
      {value > 9 ? '9+' : value}
    </span>
  )
}
