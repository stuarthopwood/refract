// The shared "where did this come from" tag (ADR 0003; issue #1041, spec 040 FR-008): a muted icon
// plus word, with an optional hover tooltip. By default it is inert chrome: the icon is hidden from
// assistive technology, it never takes focus, and it adds no layout box of its own beyond its
// content, so a row's own accessible name (set by the row) carries the same information.
// The optional `action` (#1858) adds a real link-styled button after the word, for a tag that names
// something the reader can jump to; only then does the tag hold a tab stop.
import type { ComponentType, SVGProps } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface SourceTagAction {
  label: string
  onActivate: () => void
}

interface SourceTagProps {
  icon: ComponentType<SVGProps<SVGSVGElement>>
  label: string
  /** Supplementary hover text (for example the advisor's own name); omit for none. */
  tooltip?: string
  /** Renders `action.label` as a button after the word; omit for plain text. */
  action?: SourceTagAction
  className?: string
}

export function SourceTag({ icon: Icon, label, tooltip, action, className }: SourceTagProps) {
  const tag = (
    <span data-slot="source-tag" className={cn('inline-flex shrink-0 items-center gap-1 leading-5 text-muted-foreground', className)}>
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {label}
      {action && (
        <>
          {/* A real space so textContent and copied text read "From Session Alpha"; flex drops it visually. */}
          {' '}
          {/* A native button gives Enter and Space activation for free; no key handler, or it would fire twice. */}
          <Button type="button" variant="text" size="xs" onClick={action.onActivate} className="px-1 underline">
            {action.label}
          </Button>
        </>
      )}
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
