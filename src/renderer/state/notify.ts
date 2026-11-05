import { toast } from 'sonner'
import type { IpcError } from '../../shared/ipc'

// A fresh id per refusal stops sonner conflating it with a toast mid-exit; dismiss callbacks clear
// the tracked entry only if it still matches this toast's id.
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
      }
    })
    return
  }
  toast.error(error.message, { duration: Infinity, closeButton: true })
}

/** Dismisses the open slash-command-refusal toast, but ONLY when one is tracked for THIS Session. */
export function dismissSlashCommandRefusalToast(sessionId: string): void {
  if (openRefusal !== null && openRefusal.sessionId === sessionId) {
    toast.dismiss(openRefusal.id)
    openRefusal = null
  }
}

let alertRegion: HTMLElement | null = null

function announceAssertive(text: string): void {
  if (typeof document === 'undefined') return
  if (!alertRegion || !alertRegion.isConnected) {
    alertRegion = document.createElement('div')
    alertRegion.setAttribute('role', 'alert')
    alertRegion.setAttribute('aria-live', 'assertive')
    alertRegion.setAttribute('aria-atomic', 'true')
    alertRegion.className = 'sr-only'
    document.body.appendChild(alertRegion)
  }
  const region = alertRegion
  region.textContent = ''
  setTimeout(() => {
    region.textContent = text
  }, 0)
}

/** A persistent error toast (no auto-dismiss, close button), also announced assertively. */
export function notifyPersistentError(text: string): void {
  toast.error(text, { duration: Infinity, closeButton: true })
  announceAssertive(text)
}

let alarmListOpen = false
const firedAlarmToastIds = new Set<string>()
let alarmToastCounter = 0

/** The Alarms popover lists the fired row itself, so a toast over it would only hide that row; opening it also clears earlier fired toasts. */
export function setAlarmListOpen(open: boolean): void {
  alarmListOpen = open
  if (!open) return
  for (const id of firedAlarmToastIds) toast.dismiss(id)
  firedAlarmToastIds.clear()
}

/** A fired Alarm while the window is focused; the toast stays until dismissed so a glance away cannot miss it. */
export function notifyAlarm(label: string): void {
  const text = label ? `Alarm: ${label}` : 'Alarm'
  if (alarmListOpen) {
    announceAssertive(text)
    return
  }
  // sonner's own live region announces the toast, so no second announcement here.
  const id = `alarm-fired-${++alarmToastCounter}`
  firedAlarmToastIds.add(id)
  const forget = () => firedAlarmToastIds.delete(id)
  toast.info(text, { id, duration: Infinity, closeButton: true, onDismiss: forget, onAutoClose: forget })
}

/** A deleted Alarm can be restored from its toast; it stays until dismissed so keyboard users can reach Undo. */
export function notifyAlarmDeleted(onUndo: () => void): void {
  toast('Alarm deleted', { duration: Infinity, closeButton: true, action: { label: 'Undo', onClick: onUndo } })
}

export interface ProgressToast {
  update(text: string): void
  succeed(text: string, action?: { label: string; onClick(): void }): void
  fail(text: string): void
  info(text: string): void
}

/** One non-dismissible loading toast for a background operation. */
export function notifyProgress(id: string, text: string, onCancel?: () => void): ProgressToast {
  const toastId = `progress-${id}`
  let cancelling = false
  const loadingOptions = () => ({
    id: toastId,
    duration: Infinity,
    dismissible: false,
    action: onCancel && !cancelling
      ? {
          label: 'Cancel',
          onClick: (event: { preventDefault(): void }) => {
            // Sonner deletes the toast after an action click unless it is prevented.
            event.preventDefault()
            cancelling = true
            toast.loading('Cancelling…', loadingOptions())
            onCancel()
          }
        }
      : undefined
  })
  toast.loading(text, loadingOptions())
  return {
    update: (next) => toast.loading(cancelling ? 'Cancelling…' : next, loadingOptions()),
    succeed: (next, action) =>
      toast.success(next, {
        id: toastId,
        duration: Infinity,
        dismissible: true,
        closeButton: true,
        action: action ?? undefined
      }),
    fail: (next) => {
      toast.error(next, { id: toastId, duration: Infinity, dismissible: true, closeButton: true, action: undefined })
      announceAssertive(next)
    },
    info: (next) => toast.message(next, { id: toastId, duration: 5000, dismissible: true, action: undefined })
  }
}
