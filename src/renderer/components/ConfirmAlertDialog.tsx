// Shared confirm AlertDialog (extracted from MemoryTriageDialog.tsx for issue #883, so the
// "Update now" confirmation reuses it instead of hand-building a second one): a title, a
// description, Cancel, and an optional confirm action. While `busy`, Escape, the body and both buttons are inert.
// Focus on close is the caller's choice (`onCloseAutoFocus`; `false` lets Radix restore it), since these
// dialogs open from a plain state flag with no Trigger for Radix to return focus to.
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { InlineStatus } from '@/components/InlineStatus'
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
  cancelLabel,
  size,
  error,
  children,
  bodyLabel,
  confirmDisabled = false,
  onCancel,
  onConfirm,
  onCloseAutoFocus,
  tone = 'default'
}: {
  open: boolean
  busy: boolean
  title: ReactNode
  description: ReactNode
  /** Omitted for an informational dialog that only offers the cancel button (a "can't do this yet" notice). */
  confirmLabel?: string
  busyLabel?: string
  /** Defaults to "Cancel", or "Close" when there is no confirm action. */
  cancelLabel?: string
  size?: 'default' | 'sm' | 'md'
  /** An always-mounted live region under the body: announces a failure the moment it is set. */
  error?: string | null
  /** Body content between the description and the error line (a radio group, a list). */
  children?: ReactNode
  /** Names the body group for assistive tech; give one whenever `children` is a set of controls. */
  bodyLabel?: string
  /** Blocks the confirm without the busy label (a pre-check still loading). */
  confirmDisabled?: boolean
  onCancel(): void
  onConfirm?(): void
  /** Return `false` to let Radix restore focus itself; any other result means the caller moved it. */
  onCloseAutoFocus(): boolean | void
  /** destructive fills the confirm button with the destructive colour (a close, a delete). */
  tone?: 'default' | 'destructive'
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel() }}>
      <AlertDialogContent
        size={size}
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
        {children && (
          <div role={bodyLabel ? 'group' : undefined} aria-label={bodyLabel} className="grid gap-4">
            {children}
          </div>
        )}
        {error !== undefined && (
          <InlineStatus tone="error" className={cn('p-0', !error && 'sr-only')}>
            {error ?? ''}
          </InlineStatus>
        )}
        <AlertDialogFooter className={cn(!confirmLabel && 'group-data-[size=sm]/alert-dialog-content:grid-cols-1 group-data-[size=sm]/alert-dialog-content:justify-items-end')}>
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
            {cancelLabel ?? (confirmLabel ? 'Cancel' : 'Close')}
          </AlertDialogCancel>
          {confirmLabel && (
            <AlertDialogAction
              variant={tone === 'destructive' ? 'destructive' : 'default'}
            aria-disabled={busy || confirmDisabled}
              className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
              onClick={(event) => {
                event.preventDefault()
                if (!busy && !confirmDisabled) onConfirm?.()
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

