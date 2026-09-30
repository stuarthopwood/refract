import { toast } from 'sonner'
import type { IpcError } from '../../shared/ipc'

// The renderer's one error-to-user path for IPC failures (docs/DESIGN.md "Feedback and
// errors": transient app-level problems show as a toast).
export function notify(error: IpcError): void {
  toast.error(error.message)
}
