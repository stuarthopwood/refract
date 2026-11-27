// Shared list card (#869, docs/design/components.md "Reusable components first"): a borderless, full-width row on a
// resting `bg-surface-subtle` fill whose body is one focusable button that opens its item, with one accessible name
// so a screen reader hears one stop per item. The optional `actions` slot sits beside the body, not inside it (a
// button cannot nest in a button). `surface` is the bordered `bg-surface-1` Subagents sub-card (#2318); `flush`
// keeps the hover tint and focus ring but has no fill, edge or padding, for a body that draws its own shape.
import type { MouseEvent, ReactNode } from 'react'
import { ActiveIndicatorBar } from '@/components/ActiveIndicatorBar'
import { cn } from '@/lib/utils'

export interface ListCardButtonProps {
  /** The card body's full accessible name, for example "Open Session swift-otter, project refract, needs you". */
  ariaLabel: string
  /** Receives the click event, so a caller can hand the button to a panel as the element focus returns to. */
  onClick(event: MouseEvent<HTMLButtonElement>): void
  children: ReactNode
  /** Secondary controls rendered beside the card body, vertically centred. */
  actions?: ReactNode
  /** Marks an item that just changed and needs noticing: a `bg-muted` fill plus the shared accent bar. */
  highlighted?: boolean
  /** `row` (default) is the borderless list row; `surface` the bordered `bg-surface-1` card with a block body; `flush` an unpadded block with only the hover tint. */
  variant?: 'row' | 'surface' | 'flush'
  /** Id of an element holding the card's description (for example its outcome text), so a screen reader can reach what the name leaves out. */
  ariaDescribedBy?: string
  className?: string
}

export function ListCardButton({ ariaLabel, onClick, children, actions, highlighted, variant = 'row', ariaDescribedBy, className }: ListCardButtonProps) {
  const block = variant !== 'row'
  return (
    <div
      data-highlighted={highlighted ? '' : undefined}
      className={cn(
        'relative flex w-full min-w-0 items-center gap-2 rounded-lg border bg-surface-subtle text-sm text-card-foreground transition-colors forced-colors:border-[ButtonBorder] [--ghost-hover-bg:var(--row-action-hover-bg)] hover:bg-surface-hover',
        variant === 'surface' && 'items-stretch gap-0 border-divider bg-surface-1',
        variant === 'flush' && 'items-stretch gap-0 border-transparent bg-transparent',
        variant === 'row' && 'border-transparent',
        highlighted && 'bg-muted hover:bg-muted'
      )}
    >
      {highlighted && <ActiveIndicatorBar />}
      <button
        type="button"
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        onClick={onClick}
        className={cn(
          variant === 'surface' && 'block min-w-0 flex-1 rounded-lg p-2 text-left',
          variant === 'flush' && 'block min-w-0 flex-1 rounded-lg text-left',
          !block && 'flex min-w-0 flex-1 flex-col gap-1 rounded-lg px-4 py-2 text-left',
          'focus-visible:outline-(length:--focus-ring-width) focus-visible:outline-offset-2 focus-visible:outline-ring forced-colors:focus-visible:outline-solid',
          className
        )}
      >
        {children}
      </button>
      {actions && <div className="flex shrink-0 items-center gap-1 pr-2">{actions}</div>}
    </div>
  )
}
