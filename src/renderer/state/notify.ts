import { toast } from 'sonner'
import type { IpcError } from '../../shared/ipc'

// The renderer's one error-to-user path for IPC failures (docs/DESIGN.md "Feedback and
// errors": transient app-level problems show as a toast).
//
// Issue #997: a slash command Refract does not recognise is refused as `unknown-command`
// (FR-033) -- the design doc's own wording for this is "warning", not an app-level error, so it
// gets the warning toast/icon, not the red error one. It also stays on screen rather than
// auto-dismissing (Decided, Skippy, delegated by Stuart 2026-10-19): `duration: Infinity` is
// sonner's own documented way to disable its auto-dismiss timer (confirmed in
// `node_modules/sonner/dist/index.mjs`: `toast.duration === Infinity` skips starting the close
// timer at all), so this is not a workaround -- the toast layer does allow it.
export function notify(error: IpcError): void {
  if (error.code === 'unknown-command') {
    toast.warning(error.message, { duration: Infinity })
    return
  }
  toast.error(error.message)
}
