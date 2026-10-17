import { useRef, type ReactNode, type RefObject } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { CopyButton } from '@/components/ui/copy-button'
import type { PendingTextChip } from './attachments'

export interface TextPreviewModalProps {
  chip: PendingTextChip
  trigger: ReactNode
  /** Accessibility remediation (High): when this modal is opened from the inline textarea
   * overlay's `tabIndex={-1}` mouse-only chip (never a real keyboard/AT focus stop), Radix's own
   * default close-focus-return target -- the trigger element itself -- is unreachable by
   * keyboard/AT, stranding a screen-reader user outside the accessibility tree. When provided,
   * `onCloseAutoFocus` is overridden to focus this element instead. Omitted for the strip's own
   * badge trigger, which stays a real `<button>` and keeps Radix's default return-to-trigger
   * behavior. */
  restoreFocusTo?: RefObject<HTMLElement | null>
}

/** FR-012, FR-016: the full original pasted text, read-only, selectable, and scrollable.
 * `trigger` is the clickable chip itself (`DialogTrigger asChild`) -- the same strip badge or
 * inline textarea-overlay button that opened it -- so Radix's own default focus handling (same
 * pattern as every other dialog in the app) returns focus there on Esc or an outside click,
 * unless `restoreFocusTo` overrides that target (see its own doc comment above). */
export function TextPreviewModal({ chip, trigger, restoreFocusTo }: TextPreviewModalProps) {
  // Quality-gate remediation (Medium): the Copy button now sits before the dialog's own Close
  // button in DOM order, so Radix Dialog's default initial-focus search (first tabbable element)
  // would otherwise land on Copy -- and Radix's Tooltip opens on any non-pointer-down focus, so
  // "Copy pasted text" would pop up on every open, including a mouse open. `onOpenAutoFocus`
  // below redirects initial focus to the read-only text region instead (the same pattern
  // `CodeBlock`'s own scrollable region uses), which also gives the 60vh scroll area a real
  // keyboard stop it previously lacked.
  const textRegionRef = useRef<HTMLPreElement>(null)

  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        className="sm:max-w-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          textRegionRef.current?.focus()
        }}
        onCloseAutoFocus={
          restoreFocusTo
            ? (event) => {
                event.preventDefault()
                restoreFocusTo.current?.focus()
              }
            : undefined
        }
      >
        <DialogHeader>
          {/* `pr-8` clears the dialog's own absolute top-right Close button (icon-sm, `top-2
           * right-2`) so it never overlaps this row's own trailing Copy button (#524). Always
           * visible, like every other Copy button (#524 acceptance criterion: "visible without
           * hover"). */}
          <div className="flex items-center justify-between gap-2 pr-8">
            <DialogTitle>Pasted text ({chip.text.length} characters)</DialogTitle>
            <CopyButton getText={() => chip.text} label="Copy pasted text" announcement="Pasted text copied" />
          </div>
        </DialogHeader>
        <pre
          ref={textRegionRef}
          tabIndex={0}
          role="region"
          aria-label="Pasted text"
          className="max-h-[60vh] overflow-auto rounded-md border border-border bg-muted p-3 text-xs break-words whitespace-pre-wrap outline-none focus-visible:outline-hidden focus-visible:outline-offset-[-2px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          {chip.text}
        </pre>
      </DialogContent>
    </Dialog>
  )
}
