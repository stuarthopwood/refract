import { toast } from 'sonner'
import type { IpcErrorCode } from '../../../shared/ipc'
import { useSessionsStore } from '@/state/sessions-store'

/** Raises the persistent "Could not delete" toast; a repeat failure for the same Session replaces it (same id). */
export function showDeleteFailureToast(
  session: { id: string; name: string },
  error: { code: IpcErrorCode; message: string }
): void {
  const { id, name } = session
  toast.error(`Could not delete ${name}`, {
    id: `delete-failed:${id}`,
    duration: Infinity,
    description: error.message,
    action: { label: 'Retry', onClick: () => void retryDelete(id, error.message) },
    cancel: { label: 'Details', onClick: () => useSessionsStore.getState().openDeleteDetails(id, error.message) }
  })
}

// The user already confirmed once, so Retry skips the dialog; a synchronous refusal goes to Details with its message.
async function retryDelete(id: string, previousMessage: string): Promise<void> {
  const store = useSessionsStore.getState()
  store.markDeleting(id)
  const response = await window.refract.sessions.delete(id, { confirmed: true })
  if (response.ok) return
  useSessionsStore.getState().clearDeleting(id)
  useSessionsStore.getState().openDeleteDetails(id, response.error.message || previousMessage)
}
