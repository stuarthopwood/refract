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
// every icon is `size-4` (14px) -- up from the original `text-xs`/`size-4` (12px/12px), Stuart's
// own choice over a 14px TEXT step, which would read "as loud as the chat".
import { forwardRef } from 'react'
import type { ComponentType, FocusEvent, MouseEvent, ReactNode, Ref } from 'react'
import { cn } from '@/lib/utils'

// Issue #937 gate round 1 fix note (superseded 2026-10-21, issue #700/#701 slice (b)): this
// component now forwards a ref and spreads hover/focus handlers (`onPointerEnter`/
// `onPointerLeave`/`onFocus`/`onBlur`), so a Radix `PopoverAnchor asChild`/`TooltipTrigger
// asChild` composition works directly against it -- the Todo and Agents hover-focus cards below
// anchor their own Popover straight onto this component. `AdvisorChip` still renders its own raw
// `<button>` rather than retrofitting onto this change, which only ever reached ReadoutChip's
// own three render branches. One source of truth for the classes either way -- this component
// below still uses the SAME two constants, never a second copy of the literal strings.
export const READOUT_CHIP_BASE_CLASS = 'inline-flex h-6 shrink-0 items-center gap-2 text-readout text-muted-foreground'
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
  /** Issue #700/#701: a toggle control (the Todo pill) renders real `aria-pressed` on its own
   * `<button>` -- omitted (`undefined`) by every other chip, which has no boolean on/off state
   * of its own, so this never changes their markup. The pressed LOOK is the caller's own
   * `className` (decision record item 1: "a pin glyph plus a pressed border... never the open-
   * card background"), not baked in here -- every other chip keeps today's hover-only styling. */
  pressed?: boolean
  /** Names the region `pressed` toggles (WCAG 4.1.2 `aria-controls`) -- gate round 6 fix (#700,
   * Main LOW 10): rendered only while `pressed` is true, since the region does not exist at all
   * otherwise; pointing `aria-controls` at a non-existent id outside that state is invalid. */
  controls?: string
  /** A stable `data-` hook, rendered regardless of `pressed` (gate round 6 fix, #700 Main LOW
   * 10): `PinnedTodoPanel.tsx`'s own focus-restore effect needs to find the Todo pill by the
   * time its OWN `pinned` has already flipped and `aria-controls` is already gone -- `controls`
   * alone cannot survive that moment. */
  pinHookId?: string
  /** Issue #700/#701 slice (b): wired by `useReadoutCard` so this chip is a valid hover/focus
   * Popover anchor -- opens the card on hover (after a delay) or genuine keyboard focus-visible,
   * never a plain mouse-driven focus. */
  onPointerEnter?: () => void
  onPointerLeave?: () => void
  onFocus?: (event: FocusEvent<HTMLElement>) => void
  onBlur?: (event: FocusEvent<HTMLElement>) => void
  className?: string
}

export const ReadoutChip = forwardRef<HTMLButtonElement | HTMLAnchorElement | HTMLSpanElement, ReadoutChipProps>(function ReadoutChip(
  { icon: Icon, children, onActivate, href, accessibleName, className, pressed, controls, pinHookId, onPointerEnter, onPointerLeave, onFocus, onBlur },
  ref
) {
  const baseClasses = cn(READOUT_CHIP_BASE_CLASS, className)
  const interactiveClasses = cn(baseClasses, READOUT_CHIP_INTERACTIVE_ADDITIONS)

  // H1 (gate951Test/Code): a stable structural hook for `scripts/verify-927-928-quiet-composer.mjs`
  // (and any future live check) to find every status-line chip by -- never by `.text-readout`,
  // the literal class issue #928 itself changes, which a #928 regression could silently strip
  // (as #928's own `cn` tailwind-merge bug did) without any selector ever reporting it missing.
  if (href) {
    return (
      <a
        ref={ref as Ref<HTMLAnchorElement>}
        data-slot="readout-chip"
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        aria-label={accessibleName}
        className={interactiveClasses}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {Icon && <Icon aria-hidden className="size-4" />}
        {children}
      </a>
    )
  }

  if (onActivate) {
    return (
      <button
        ref={ref as Ref<HTMLButtonElement>}
        data-slot="readout-chip"
        type="button"
        onClick={onActivate}
        aria-label={accessibleName}
        aria-pressed={pressed}
        aria-controls={pressed ? controls : undefined}
        data-todo-pin-hook={pinHookId}
        className={interactiveClasses}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {Icon && <Icon aria-hidden className="size-4" />}
        {children}
      </button>
    )
  }

  return (
    <span ref={ref as Ref<HTMLSpanElement>} data-slot="readout-chip" className={baseClasses} aria-label={accessibleName}>
      {Icon && <Icon aria-hidden className="size-4" />}
      {children}
    </span>
  )
})
