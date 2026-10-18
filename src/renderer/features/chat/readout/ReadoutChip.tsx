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

// Issue #937 gate round 1 fix: exported so `ReadoutChips.tsx`'s `AdvisorChip` can render its own
// raw `<button>` (not this component) and still share the exact same classes -- it needs a real
// Radix `TooltipTrigger asChild` composition (ref + hover/focus event props merged straight onto
// the DOM node), which a hand-rolled, non-forwardRef component like this one cannot support
// without a much larger generic-prop-spreading change; a plain DOM element composes with Radix
// `Slot` for free. One source of truth for the classes either way -- this component below still
// uses the SAME two constants, never a second copy of the literal strings.
export const READOUT_CHIP_BASE_CLASS = 'inline-flex h-6 shrink-0 items-center gap-1.5 text-readout text-muted-foreground'
// Gate round 1 fix (MEDIUM): the plain-text restyle above dropped `badgeVariants`' own
// `focus-visible:border-ring ring-[3px]` ring entirely -- an interactive Readout had no
// explicit focus style at all, only the browser default outline. Opaque (no `/50` alpha),
// the codebase's own `outline-ring` convention (`CollapsedLine.tsx`).
export const READOUT_CHIP_INTERACTIVE_ADDITIONS =
  'rounded-md px-1 -mx-1 hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

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
  const baseClasses = cn(READOUT_CHIP_BASE_CLASS, className)
  const interactiveClasses = cn(baseClasses, READOUT_CHIP_INTERACTIVE_ADDITIONS)

  // H1 (gate951Test/Code): a stable structural hook for `scripts/verify-927-928-quiet-composer.mjs`
  // (and any future live check) to find every status-line chip by -- never by `.text-readout`,
  // the literal class issue #928 itself changes, which a #928 regression could silently strip
  // (as #928's own `cn` tailwind-merge bug did) without any selector ever reporting it missing.
  if (href) {
    return (
      <a data-slot="readout-chip" href={href} target="_blank" rel="noreferrer noopener" aria-label={accessibleName} className={interactiveClasses}>
        {Icon && <Icon aria-hidden className="size-3.5" />}
        {children}
      </a>
    )
  }

  if (onActivate) {
    return (
      <button data-slot="readout-chip" type="button" onClick={onActivate} aria-label={accessibleName} className={interactiveClasses}>
        {Icon && <Icon aria-hidden className="size-3.5" />}
        {children}
      </button>
    )
  }

  return (
    <span data-slot="readout-chip" className={baseClasses} aria-label={accessibleName}>
      {Icon && <Icon aria-hidden className="size-3.5" />}
      {children}
    </span>
  )
}
