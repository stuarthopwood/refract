// A short outlined status badge with a hover tooltip (ADR 0003; #1749). Like SourceTag it is inert
// chrome: it never takes focus and adds no tab stop. `decorative` hides it from assistive technology
// where a parent's own accessible name (a row's label) or visible text already says the tooltip;
// otherwise the tooltip text follows the label for screen readers, so the badge is announced in full.
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export interface NoteBadgeProps {
  label: string
  tooltip: string
  decorative?: boolean
}

export function NoteBadge({ label, tooltip, decorative = false }: NoteBadgeProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild tabIndex={-1} aria-describedby={undefined}>
        <Badge variant="outline" data-slot="note-badge" aria-hidden={decorative || undefined}>
          {label}
          {!decorative && <span className="sr-only">: {tooltip}</span>}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
