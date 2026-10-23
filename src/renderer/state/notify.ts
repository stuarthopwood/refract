import { toast } from 'sonner'
import type { IpcError } from '../../shared/ipc'

// The renderer's one error-to-user path for IPC failures (docs/DESIGN.md "Feedback and
// errors": transient app-level problems show as a toast).
//
// Issue #997: a slash command Refract refuses (`unknown-command`/`unsupported-arguments`,
// FR-032/FR-033) is a warning, not an app-level error -- the design doc's own wording for this
// is "warning", so it gets the warning toast/icon, not the red error one, with a close button
// and no auto-dismiss timer (`duration: Infinity` disables sonner's own close timer, confirmed
// in `node_modules/sonner/dist/index.mjs`).
//
// Gate round 2 (HIGH, confirmed live in sonner's own Toaster merge, `index.mjs:1033-1046`): a
// FIXED toast id used to dedupe repeated refusals in place -- but a refusal raised inside
// sonner's own ~200ms exit-animation window (after the user closes the current one) merged into
// that still-closing entry, which keeps its internal `delete: true` flag, and the "new" refusal
// silently never showed. Each refusal now gets a FRESH id (`refusalCounter`, module-scoped) --
// sonner can never conflate it with one that is mid-exit. `openRefusal` tracks the one refusal
// currently on screen (its id and the Session it belongs to); a second refusal explicitly
// dismisses the previous one first (`toast.dismiss`, not relying on an id collision), so exactly
// one is ever shown. `onDismiss`/`onAutoClose` clear the tracked entry only if it still matches
// THIS toast's own id -- a stale callback from an already-superseded refusal (its `toast.dismiss`
// call above fires asynchronously, after `openRefusal` has already moved on) is a safe no-op.
let refusalCounter = 0
let openRefusal: { id: string; sessionId: string } | null = null

const SLASH_COMMAND_REFUSAL_CODES: Partial<Record<IpcError['code'], true>> = {
  'unknown-command': true,
  'unsupported-arguments': true
}

export function notify(error: IpcError, sessionId?: string): void {
  if (SLASH_COMMAND_REFUSAL_CODES[error.code]) {
    if (openRefusal) toast.dismiss(openRefusal.id)
    const id = `slash-command-refusal-${++refusalCounter}`
    openRefusal = sessionId !== undefined ? { id, sessionId } : null
    toast.warning(error.message, {
      id,
      duration: Infinity,
      closeButton: true,
      onDismiss: () => {
        if (openRefusal?.id === id) openRefusal = null
      },
      onAutoClose: () => {
        if (openRefusal?.id === id) openRefusal = null
      }
    })
    return
  }
  toast.error(error.message)
}

/** Dismisses the open slash-command-refusal toast, but ONLY when one is tracked for THIS
 * Session -- never a blind `toast.dismiss` on every call (that would also force an unneeded
 * Toaster re-render for every OTHER mounted toast each time this runs). A mismatched or absent
 * `sessionId` is a plain no-op: sonner is never called at all. */
export function dismissSlashCommandRefusalToast(sessionId: string): void {
  if (openRefusal !== null && openRefusal.sessionId === sessionId) {
    toast.dismiss(openRefusal.id)
    openRefusal = null
  }
}
