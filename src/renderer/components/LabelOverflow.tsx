// The "+N" chip that stands for labels a list row has no room to show (#1740, #1873). It is a focusable
// text-only chip (accent text, no border in any state, so it does not read as a command button), and
// keyboard and pointer users both open a tooltip listing every hidden label with its colour dot. The
// accessible name starts with the visible "+N" (WCAG 2.5.3) and names every hidden label. Label names are
// untrusted text, rendered as plain text.
import { ColourDot } from '@/components/ColourDot'
import { overflowChipName } from '@/components/overflowLabels'
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
  const accessibleName = overflowChipName(labels)
  return (
    <Tooltip>
      <TooltipTrigger asChild aria-describedby={undefined}>
        <Badge asChild variant="plain" className={cn('h-6 min-w-6 cursor-default', className)}>
          <button type="button" aria-label={accessibleName}>
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
