import { toast } from 'sonner'
import type { IpcError } from '../../shared/ipc'

// The renderer's one error-to-user path for IPC failures (docs/DESIGN.md "Feedback and
// errors": transient app-level problems show as a toast).
//
// Issue #997: a slash command Refract refuses (`unknown-command`/`unsupported-arguments`,
// FR-032/FR-033) is a warning, not an app-level error -- the design doc's own wording for this
// is "warning", so it gets the warning toast/icon, not the red error one. Gate round 1 (Skippy,
// delegated by Stuart 2026-10-19): it also stays on screen until the user dismisses it, not just
// past its own auto-dismiss timer -- `duration: Infinity` disables sonner's close timer
// (confirmed in `node_modules/sonner/dist/index.mjs`: `toast.duration === Infinity` skips
// starting it at all) and `closeButton: true` gives it the explicit dismiss control (the
// Toaster's own global `closeButton` stays off for every other toast, `components/ui/
// sonner.tsx`). A fixed `id` (sonner's own in-place-replace key, the same pattern `ProfileMenu.
// tsx`'s `UpdateMenuItem` already uses) means a SECOND refusal while the first is still open
// replaces it in place rather than stacking a duplicate -- `dismissSlashCommandRefusalToast()`
// below (called by `MessageInput.tsx` on a successful send or once the draft changes) is the
// SAME id, so `toast.dismiss(id)` always targets the one open refusal toast, never a stale one.
export const SLASH_COMMAND_REFUSAL_TOAST_ID = 'slash-command-refusal'

const SLASH_COMMAND_REFUSAL_CODES: Partial<Record<IpcError['code'], true>> = {
  'unknown-command': true,
  'unsupported-arguments': true
}

export function notify(error: IpcError): void {
  if (SLASH_COMMAND_REFUSAL_CODES[error.code]) {
    toast.warning(error.message, { id: SLASH_COMMAND_REFUSAL_TOAST_ID, duration: Infinity, closeButton: true })
    return
  }
  toast.error(error.message)
}

/** Clears the one open slash-command-refusal toast, if any -- a no-op `toast.dismiss` call when
 * none is open (sonner itself only ever acts on a toast id that actually exists), so callers
 * never need to track whether one is currently showing. */
export function dismissSlashCommandRefusalToast(): void {
  toast.dismiss(SLASH_COMMAND_REFUSAL_TOAST_ID)
}
