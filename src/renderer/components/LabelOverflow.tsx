// The "+N" chip that stands for labels a list row has no room to show (#1740). It is a focusable
// pill, so keyboard and pointer users both open a tooltip listing every hidden label with its colour
// dot; the accessible name carries the names too. Label names are untrusted text, rendered as plain text.
import { ColourDot } from '@/components/ColourDot'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface OverflowLabel {
  name: string
  /** Six hex digits without `#`, as `ColourDot` takes it. */
  color: string
}

export function LabelOverflow({ labels, className }: { labels: readonly OverflowLabel[]; className?: string }) {
  if (labels.length === 0) return null
  const noun = labels.length === 1 ? 'label' : 'labels'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge asChild variant="outline" className={cn('h-6 min-w-6 cursor-default text-muted-foreground hover:border-ring hover:text-foreground', className)}>
          <button type="button" aria-label={`${labels.length} more ${noun}: ${labels.map((label) => label.name).join(', ')}`}>
            +{labels.length}
          </button>
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-1">
        {labels.map((label) => (
          <span key={label.name} className="flex max-w-full items-center gap-1">
            <ColourDot color={label.color} />
            <span className="break-words">{label.name}</span>
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}
