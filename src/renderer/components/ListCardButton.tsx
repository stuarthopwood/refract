// Shared one-button list card (#869, docs/design/components.md "Reusable components first"): a
// bordered, full-width button that opens its item. The whole card is one focusable control with
// one accessible name, so a screen reader hears one stop per item.
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface ListCardButtonProps {
  /** The card's full accessible name, for example "Open Session swift-otter, project refract, needs you". */
  ariaLabel: string
  onClick(): void
  children: ReactNode
  className?: string
}

export function ListCardButton({ ariaLabel, onClick, children, className }: ListCardButtonProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className={cn(
        'flex w-full min-w-0 flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2 text-left text-sm text-card-foreground transition-colors hover:bg-muted/50',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring forced-colors:focus-visible:outline-solid',
        className
      )}
    >
      {children}
    </button>
  )
}
