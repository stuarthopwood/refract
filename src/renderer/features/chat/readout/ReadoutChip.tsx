// Shared chip baseline (spec 004 FR-001, FR-009, FR-010): icon slot, label/value content, an
// optional `onActivate` making it a keyboard-operable button with an accessible name, otherwise a
// plain element readable as one phrase through a screen reader. Every chip in the row (spec 004
// data-model.md "Readout chip") builds on this, the same way every non-message chat output builds
// on the shared `CollapsedLine` baseline (docs/DESIGN.md "Chat").
import type { ComponentType, ReactNode } from 'react'
import { badgeVariants } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export interface ReadoutChipProps {
  icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  children: ReactNode
  onActivate?: () => void
  /** An external URL (e.g. the Pull request chip, FR-006): renders a real `<a target="_blank">`
   * instead of a button, so Electron's existing `setWindowOpenHandler` opens it in the system
   * browser (the same pattern Markdown.tsx already uses for external links) with no new IPC. */
  href?: string
  /** Required when `onActivate` or `href` is set: the accessible name stating what the chip opens. */
  accessibleName?: string
  className?: string
}

export function ReadoutChip({ icon: Icon, children, onActivate, href, accessibleName, className }: ReadoutChipProps) {
  const baseClasses = cn(badgeVariants({ variant: 'outline' }), 'h-6 shrink-0 gap-1.5 px-2.5', className)
  const interactiveClasses = cn(baseClasses, 'hover:bg-muted aria-expanded:bg-muted')

  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" aria-label={accessibleName} className={interactiveClasses}>
        {Icon && <Icon aria-hidden className="size-3" />}
        {children}
      </a>
    )
  }

  if (onActivate) {
    return (
      <button type="button" onClick={onActivate} aria-label={accessibleName} className={interactiveClasses}>
        {Icon && <Icon aria-hidden className="size-3" />}
        {children}
      </button>
    )
  }

  return (
    <span className={baseClasses} aria-label={accessibleName}>
      {Icon && <Icon aria-hidden className="size-3" />}
      {children}
    </span>
  )
}
