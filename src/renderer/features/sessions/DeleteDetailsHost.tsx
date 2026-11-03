import { DeleteDialog } from './DeleteDialog'
import { useSessionsStore } from '@/state/sessions-store'

/** Hosts the failure Details dialog opened from the "Could not delete" toast; Retry there re-runs the delete. */
export function DeleteDetailsHost() {
  const details = useSessionsStore((s) => s.deleteDetails)
  const name = useSessionsStore((s) => s.sessions.find((x) => x.id === details?.id)?.name)
  const closeDeleteDetails = useSessionsStore((s) => s.closeDeleteDetails)
  if (!details || !name) return null
  return (
    <DeleteDialog
      session={{ id: details.id, name }}
      open
      initialError={details.message}
      onOpenChange={(open) => {
        if (!open) closeDeleteDetails()
      }}
    />
  )
}
