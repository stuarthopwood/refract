import * as React from 'react'
import { disclosureToggleClassName } from '@/features/chat/linkStyles'

export interface InlineDisclosureProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  contentId: string
  label: React.ReactNode
  children: React.ReactNode
}

// ADR 0003 (reusable UI components only): the one text-link disclosure shape this app uses to
// reveal more detail inline, without its own dialog or popover -- lifted out of `Markdown.tsx`'s
// `MermaidBlock` ("Show source for ...") so issue #1077's second caller (`ToolRow.tsx`'s
// `SubagentBody`, "See input & output") reuses the identical shape instead of a second
// hand-rolled copy, per the issue's own cited precedent. `open` is fully controlled by the
// caller (never local state here) so each caller keeps its own reset rule -- `SubagentBody`'s
// own local `useState(false)` naturally starts collapsed on every fresh mount (issue #1077
// decision 3); `MermaidBlock` keeps its own `showSource` exactly as before. Gate round 1 fix
// (item 10, LOW): no `className`/`buttonClassName` escape hatch -- neither caller ever used one,
// and the trigger's own look is now the shared `mutedLinkClassName` (below), matching
// `StageContextBrief.tsx`'s "Show full brief" toggle exactly rather than a third, one-off look.
//
// The `onKeyDown` listener lives on this OUTER wrapper, not only the content `div` (gate round 1
// fix, item 3): Escape must close the disclosure and return focus to the trigger whether focus
// currently sits on the trigger itself or deep inside the content (a CodeBlock's own Copy
// button, a Markdown link) -- the WAI-ARIA Authoring Practices' recommended behaviour for a
// disclosure with interactive content, and the same WCAG 2.4.3 hazard issue #991/#1001 fixed one
// level up (a Stage's own trigger) for the unrelated case of the CONTENT ITSELF unmounting out
// from under focus; this toggle's own content never unmounts (only `hidden`), so a plain Escape
// handler already covers both cases with one listener. `event.defaultPrevented` is checked first
// (gate round 1 fix, item 3): a nested control with its OWN Escape behaviour (a Tooltip's own
// dismiss, WCAG 1.4.13 "dismissible") must get the first press to itself -- if that inner
// handler already consumed the key (called `preventDefault()`), this one must not ALSO close the
// whole disclosure out from under it.
export function InlineDisclosure({ open, onOpenChange, contentId, label, children }: InlineDisclosureProps) {
  const buttonRef = React.useRef<HTMLButtonElement>(null)

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !open) return
      event.stopPropagation()
      onOpenChange(false)
      // Gate round 1 fix (item 4, MEDIUM): no `preventScroll` -- a focused element deep inside a
      // long, internally-scrolled content area (a tall `CodeBlock`) must come back into view, not
      // merely regain DOM focus off-screen; the browser's own default focus-scroll handles this.
      buttonRef.current?.focus()
    },
    [open, onOpenChange]
  )

  return (
    <div className="space-y-1" onKeyDown={open ? handleKeyDown : undefined}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => onOpenChange(!open)}
        className={disclosureToggleClassName}
      >
        {label}
      </button>
      {/* Gate round 1 fix (item 5, MEDIUM): `space-y-2` restores the 8px gap `SubagentBody`'s own
          Prompt/Result blocks used to get for free from `CollapsibleContent`'s own ambient
          `space-y-2` before this content moved one level deeper, inside this div. */}
      <div id={contentId} hidden={!open} className="space-y-2">
        {children}
      </div>
    </div>
  )
}
