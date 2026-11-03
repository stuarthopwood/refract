import { DeleteDialog } from './DeleteDialog'
import { useSessionsStore } from '@/state/sessions-store'
import { focusSessionRow, focusSessionsNav } from '@/lib/focus'

/** Hosts the failure Details dialog opened from the "Could not delete" toast; Retry there re-runs the delete. */
export function DeleteDetailsHost() {
  const details = useSessionsStore((s) => s.deleteDetails)
  const name = useSessionsStore((s) => s.sessions.find((x) => x.id === details?.id)?.name)
  const closeDeleteDetails = useSessionsStore((s) => s.closeDeleteDetails)
  if (!details || !name) return null
  const { id } = details
  // Closing Details or a successful Retry would otherwise drop focus to <body>.
  const restoreFocus = () => {
    if (!focusSessionRow(id)) focusSessionsNav()
  }
  return (
    <DeleteDialog
      session={{ id, name }}
      open
      initialError={details.message}
      onCancelled={restoreFocus}
      onDeleted={restoreFocus}
      onOpenChange={(open) => {
        if (!open) closeDeleteDetails()
      }}
    />
  )
}
