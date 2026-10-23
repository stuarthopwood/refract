// Shared confirm AlertDialog (extracted from MemoryTriageDialog.tsx for issue #883, so the
// "Update now" confirmation reuses it instead of hand-building a second one): a title, a
// description, Cancel, and one confirm action. While `busy`, Escape and both buttons are inert.
// Focus on close is always the caller's choice (`onCloseAutoFocus`), since these dialogs open
// from a plain state flag with no Trigger for Radix to return focus to.
import type { ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'

export function ConfirmAlertDialog({
  open,
  busy,
  title,
  description,
  confirmLabel,
  busyLabel,
  onCancel,
  onConfirm,
  onCloseAutoFocus
}: {
  open: boolean
  busy: boolean
  title: ReactNode
  description: ReactNode
  confirmLabel: string
  busyLabel: string
  onCancel(): void
  onConfirm(): void
  onCloseAutoFocus(): void
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel() }}>
      <AlertDialogContent
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onCloseAutoFocus()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            aria-disabled={busy}
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            onClick={(event) => {
              if (busy) {
                event.preventDefault()
                return
              }
              onCancel()
            }}
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="invert"
            aria-disabled={busy}
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            onClick={(event) => {
              event.preventDefault()
              onConfirm()
            }}
          >
            {busy ? busyLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
