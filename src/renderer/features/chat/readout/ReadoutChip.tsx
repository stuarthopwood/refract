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
//
// Issue #928 (status line font size, 2026-10-16 grill): every chip's text is `text-readout`
// (13px, docs/design/foundations-typography-spacing.md "Status line type", globals.css) and
// every icon is `size-3.5` (14px) -- up from the original `text-xs`/`size-3` (12px/12px), Stuart's
// own choice over a 14px TEXT step, which would read "as loud as the chat".
import type { ComponentType, MouseEvent, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface ReadoutChipProps {
  icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  children: ReactNode
  /** Issue #563 gate remediation (L2/L6 across reviewers): widened to accept the click event so
   * callers that open a panel pre-selected on a specific agent (e.g. `ReadoutChips.tsx`'s own
   * Subagents Readout) can record `event.currentTarget` as the opener (FR-027) -- a plain
   * `() => {...}` callback still satisfies this (JS/TS callback arity is contravariant-
   * permissive), so no other existing caller breaks. */
  onActivate?: (event: MouseEvent<HTMLButtonElement>) => void
  /** An external URL (e.g. the Pull request Readout, FR-006): renders a real `<a target="_blank">`
   * instead of a button, so the system browser opens it (the same pattern Markdown.tsx already
   * uses for external links) with no new IPC. */
  href?: string
  /** Required when `onActivate` or `href` is set: the accessible name stating what it opens. */
  accessibleName?: string
  className?: string
}

export function ReadoutChip({ icon: Icon, children, onActivate, href, accessibleName, className }: ReadoutChipProps) {
  const baseClasses = cn('inline-flex h-6 shrink-0 items-center gap-1.5 text-readout text-muted-foreground', className)
  // Gate round 1 fix (MEDIUM): the plain-text restyle above dropped `badgeVariants`' own
  // `focus-visible:border-ring ring-[3px]` ring entirely -- an interactive Readout had no
  // explicit focus style at all, only the browser default outline. Opaque (no `/50` alpha),
  // the codebase's own `outline-ring` convention (`CollapsedLine.tsx`).
  const interactiveClasses = cn(
    baseClasses,
    'rounded-md px-1 -mx-1 hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
  )

  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" aria-label={accessibleName} className={interactiveClasses}>
        {Icon && <Icon aria-hidden className="size-3.5" />}
        {children}
      </a>
    )
  }

  if (onActivate) {
    return (
      <button type="button" onClick={onActivate} aria-label={accessibleName} className={interactiveClasses}>
        {Icon && <Icon aria-hidden className="size-3.5" />}
        {children}
      </button>
    )
  }

  return (
    <span className={baseClasses} aria-label={accessibleName}>
      {Icon && <Icon aria-hidden className="size-3.5" />}
      {children}
    </span>
  )
}
