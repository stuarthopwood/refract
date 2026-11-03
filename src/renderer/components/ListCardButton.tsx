// Shared list card (#869, docs/design/components.md "Reusable components first"): a borderless,
// full-width row on a resting `bg-surface-subtle` fill (visible on a popover) whose body is one
// focusable button that opens its item, with one accessible name so a screen reader hears one stop per item.
// The optional `actions` slot sits beside the body, not inside it (a button cannot nest in a button),
// for a secondary control such as Archive.
import type { ReactNode } from 'react'
import { ActiveIndicatorBar } from '@/components/ActiveIndicatorBar'
import { cn } from '@/lib/utils'

export interface ListCardButtonProps {
  /** The card body's full accessible name, for example "Open Session swift-otter, project refract, needs you". */
  ariaLabel: string
  onClick(): void
  children: ReactNode
  /** Secondary controls rendered beside the card body, vertically centred. */
  actions?: ReactNode
  /** Marks an item that just changed and needs noticing: a `bg-muted` fill plus the shared accent bar. */
  highlighted?: boolean
  className?: string
}

export function ListCardButton({ ariaLabel, onClick, children, actions, highlighted, className }: ListCardButtonProps) {
  return (
    <div
      data-highlighted={highlighted ? '' : undefined}
      className={cn(
        'relative flex w-full min-w-0 items-center gap-2 rounded-lg border border-transparent bg-surface-subtle text-sm text-card-foreground transition-colors forced-colors:border-[ButtonBorder] [--ghost-hover-bg:var(--row-action-hover-bg)] hover:bg-surface-hover',
        highlighted && 'bg-muted hover:bg-muted'
      )}
    >
      {highlighted && <ActiveIndicatorBar />}
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={onClick}
        className={cn(
          'flex min-w-0 flex-1 flex-col gap-1 rounded-lg px-4 py-2 text-left',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring forced-colors:focus-visible:outline-solid',
          className
        )}
      >
        {children}
      </button>
      {actions && <div className="flex shrink-0 items-center gap-1 pr-2">{actions}</div>}
    </div>
  )
}
