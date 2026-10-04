import type { ReactNode, RefObject } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
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
  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        className="sm:max-w-xl"
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
          <DialogTitle>Pasted text ({chip.text.length} characters)</DialogTitle>
        </DialogHeader>
        <pre className="max-h-[60vh] overflow-auto rounded-md border border-border bg-muted p-3 text-xs break-words whitespace-pre-wrap">
          {chip.text}
        </pre>
      </DialogContent>
    </Dialog>
  )
}
