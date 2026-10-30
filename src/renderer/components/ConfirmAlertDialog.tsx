// Shared confirm AlertDialog (extracted from MemoryTriageDialog.tsx for issue #883, so the
// "Update now" confirmation reuses it instead of hand-building a second one): a title, a
// description, Cancel, and one confirm action. While `busy`, Escape and both buttons are inert.
// Focus on close is always the caller's choice (`onCloseAutoFocus`), since these dialogs open
// from a plain state flag with no Trigger for Radix to return focus to.
import type { ReactNode, Ref } from 'react'
import { cn } from '@/lib/utils'
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
  cancelLabel = 'Cancel',
  size,
  error,
  children,
  cancelRef,
  onCancel,
  onConfirm,
  onCloseAutoFocus,
  onOpenAutoFocus,
  tone = 'default'
}: {
  open: boolean
  busy: boolean
  title: ReactNode
  description: ReactNode
  /** Omitted for an informational dialog that only offers the cancel button (a "can't do this yet" notice). */
  confirmLabel?: string
  busyLabel?: string
  cancelLabel?: string
  size?: 'default' | 'sm' | 'md'
  /** An always-mounted live region under the body: announces a failure the moment it is set. */
  error?: string | null
  /** Body content between the description and the error line (a radio group, a list). */
  children?: ReactNode
  cancelRef?: Ref<HTMLButtonElement>
  onCancel(): void
  onConfirm?(): void
  /** Return `false` to let Radix restore focus itself; any other result means the caller moved it. */
  onCloseAutoFocus(): boolean | void
  /** Runs on open; `preventDefault` stops Radix focusing the first control. */
  onOpenAutoFocus?(event: Event): void
  /** destructive fills the confirm button with the destructive colour (a close, a delete). */
  tone?: 'default' | 'destructive'
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel() }}>
      <AlertDialogContent
        size={size}
        onOpenAutoFocus={onOpenAutoFocus}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
        onCloseAutoFocus={(event) => {
          if (onCloseAutoFocus() !== false) event.preventDefault()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        {error !== undefined && (
          <p role="alert" className={cn('text-sm text-destructive', !error && 'sr-only')}>
            {error ?? ''}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel
            ref={cancelRef}
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
            {cancelLabel}
          </AlertDialogCancel>
          {confirmLabel && (
            <AlertDialogAction
              variant={tone === 'destructive' ? 'destructive' : 'invert'}
              aria-disabled={busy}
              className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
              onClick={(event) => {
                event.preventDefault()
                if (!busy) onConfirm?.()
              }}
            >
              {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

