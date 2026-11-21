// The shared "where did this come from" tag (ADR 0003; issue #1041, spec 040 FR-008): a muted icon
// plus word, with an optional hover tooltip. By default it is inert chrome: the icon is hidden from
// assistive technology, it never takes focus, and it adds no layout box of its own, so a row's
// own accessible name carries the same information.
// The optional `action` (#1858) adds a link-styled button, the only tab stop; the optional `detail`
// is quoted text that wraps and clamps to two lines instead of widening the tag.
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
  /** Wrapping text after the label, clamped to two lines (the icon and label then sit at the top); omit and the tag stays one unbreakable line. */
  detail?: string
  /** Supplementary hover text (for example the advisor's own name); omit for none. */
  tooltip?: string
  /** Renders `action.label` as a button after the word; omit for plain text. */
  action?: SourceTagAction
  /** Id on a span around the label and detail only, for a group's `aria-labelledby` that must not read `action`. */
  nameId?: string
  className?: string
}

export function SourceTag({ icon: Icon, label, detail, tooltip, action, nameId, className }: SourceTagProps) {
  const tag = (
    <span
      data-slot="source-tag"
      className={cn(detail === undefined ? 'inline-flex shrink-0 items-center' : 'inline-flex max-w-full min-w-0 items-start', 'gap-1 leading-5 text-muted-foreground', className)}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {detail === undefined ? (
        nameId === undefined ? (
          label
        ) : (
          <span id={nameId}>{label}</span>
        )
      ) : (
        // The name wraps only the words, so a screen reader does not read the action into the bubble's name.
        <span id={nameId} className="inline-flex min-w-0 items-start gap-1">
          <span className="shrink-0">{label}</span>
          {/* A real space so textContent and copied text keep the label apart from the quoted words. */}
          {' '}
          <span className="line-clamp-2 min-w-0 break-words">{detail}</span>
        </span>
      )}
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
