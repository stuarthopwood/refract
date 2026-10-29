// The shared "where did this come from" tag (ADR 0003; issue #1041, spec 040 FR-008): a muted icon
// plus word, with an optional hover tooltip. It is inert chrome: the icon is hidden from assistive
// technology, it never takes focus, and it adds no layout box of its own beyond its content, so a
// row's own accessible name (set by the row) carries the same information.
import type { ComponentType, SVGProps } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface SourceTagProps {
  icon: ComponentType<SVGProps<SVGSVGElement>>
  label: string
  /** Supplementary hover text (for example the advisor's own name); omit for none. */
  tooltip?: string
  className?: string
}

export function SourceTag({ icon: Icon, label, tooltip, className }: SourceTagProps) {
  const tag = (
    <span data-slot="source-tag" className={cn('inline-flex shrink-0 items-center gap-1 text-xs leading-5 text-muted-foreground', className)}>
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {label}
    </span>
  )
  if (!tooltip) return tag
  return (
    <Tooltip>
      <TooltipTrigger asChild tabIndex={-1} aria-describedby={undefined}>
        {tag}
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
