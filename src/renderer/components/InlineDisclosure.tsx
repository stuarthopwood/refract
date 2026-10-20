import * as React from 'react'
import { cn } from '@/lib/utils'

export interface InlineDisclosureProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  contentId: string
  label: string
  className?: string
  buttonClassName?: string
  children: React.ReactNode
}

// ADR 0003 (reusable UI components only): the one text-link disclosure shape this app uses to
// reveal more detail inline, without its own dialog or popover -- lifted out of `Markdown.tsx`'s
// `MermaidBlock` ("Show source for ...") so issue #1077's second caller (`ToolRow.tsx`'s
// `SubagentBody`, "See input & output") reuses the identical shape instead of a second
// hand-rolled copy, per the issue's own cited precedent. `open` is fully controlled by the
// caller (never local state here) so each caller keeps its own reset rule -- `SubagentBody`'s
// own local `useState(false)` naturally starts collapsed on every fresh mount (issue #1077
// decision 3); `MermaidBlock` keeps its own `showSource` exactly as before.
//
// Escape closes the content and returns focus to this trigger even when focus currently sits
// deep inside the content (a CodeBlock's own Copy button, a Markdown link) -- the WAI-ARIA
// Authoring Practices' recommended behaviour for a disclosure with interactive content, and the
// same WCAG 2.4.3 hazard issue #991/#1001 fixed one level up (a Stage's own trigger) for the
// unrelated case of the CONTENT ITSELF unmounting out from under focus; this toggle's own
// content never unmounts (only `hidden`), so a plain Escape handler already covers it -- no
// focus-tracking ref needed.
//
// Tailwind 4.3.3 trap (found while building this): `outline-none` alone leaves
// `focus-visible:outline-2` painting no ring at all -- `focus-visible:outline-solid` is
// required alongside it to re-enable the outline style the base class turned off (the same fix
// `GitChangesFileRow.tsx`/`AdvisoryRow.tsx`/`SubagentPanel.tsx` already carry).
export function InlineDisclosure({ open, onOpenChange, contentId, label, className, buttonClassName, children }: InlineDisclosureProps) {
  const buttonRef = React.useRef<HTMLButtonElement>(null)

  const handleContentKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onOpenChange(false)
      buttonRef.current?.focus({ preventScroll: true })
    },
    [onOpenChange]
  )

  return (
    <div className={cn('space-y-1', className)}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => onOpenChange(!open)}
        className={cn(
          '-mx-1 px-1 py-1 text-xs text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring',
          buttonClassName
        )}
      >
        {label}
      </button>
      <div id={contentId} hidden={!open} onKeyDown={open ? handleContentKeyDown : undefined}>
        {children}
      </div>
    </div>
  )
}
