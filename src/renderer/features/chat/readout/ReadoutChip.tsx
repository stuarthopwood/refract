// Shared Status line baseline (spec 004 FR-001, FR-009, FR-010, FR-023): icon slot, label/value
// content, an optional `onActivate` making it a keyboard-operable control with an accessible
// name, otherwise a plain element readable as one phrase through a screen reader. Every Readout
// in the Status line (spec 004 data-model.md) builds on this, the same way every non-message chat
// output builds on the shared `CollapsedLine` baseline (docs/DESIGN.md "Chat").
//
// Plain text, no box (2026-10-15 grill, issue #564, decision 1 -- the zero-box rule and the
// mock): a read-only Readout is an icon plus text with no border or fill; one that opens
// something (onActivate/href) is a quiet text control with a hover background, still no border.
// This retires the earlier pill/chip look (CONTEXT.md "Status line").
import type { ComponentType, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface ReadoutChipProps {
  icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  children: ReactNode
  onActivate?: () => void
  /** An external URL (e.g. the Pull request Readout, FR-006): renders a real `<a target="_blank">`
   * instead of a button, so the system browser opens it (the same pattern Markdown.tsx already
   * uses for external links) with no new IPC. */
  href?: string
  /** Required when `onActivate` or `href` is set: the accessible name stating what it opens. */
  accessibleName?: string
  className?: string
}

export function ReadoutChip({ icon: Icon, children, onActivate, href, accessibleName, className }: ReadoutChipProps) {
  const baseClasses = cn('inline-flex h-6 shrink-0 items-center gap-1.5 text-xs text-muted-foreground', className)
  const interactiveClasses = cn(baseClasses, 'rounded-md px-1 -mx-1 hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground')

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
