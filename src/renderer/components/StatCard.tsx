// The shared stat card (spec 060 S2-02, ADR 0003): a label, a big value and an optional caption,
// read by a screen reader as one unit (a labelled group, label then value then caption).
import { useId } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export interface StatCardProps {
  label: string
  value: string
  /** One short muted line under the value. */
  caption?: string
  className?: string
}

export function StatCard({ label, value, caption, className }: StatCardProps) {
  const labelId = useId()
  const valueId = useId()
  const captionId = useId()
  return (
    <Card
      role="group"
      aria-labelledby={labelId}
      aria-describedby={caption ? `${valueId} ${captionId}` : valueId}
      className={cn('min-w-0', className)}
    >
      <CardContent className="flex flex-col gap-1">
        <p id={labelId} className="break-words text-xs text-muted-foreground">
          {label}
        </p>
        <p id={valueId} className="break-words text-xl font-semibold tabular-nums">
          {value}
        </p>
        {caption && (
          <p id={captionId} className="text-xs text-muted-foreground">
            {caption}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
