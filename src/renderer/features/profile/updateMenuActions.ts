// What the profile menu's update item does when chosen. Kept out of the component so each toast branch is testable without a menu.
import { toast } from 'sonner'
import { updateUnavailableReasonText } from '@/lib/updateStatus'
import type { UpdateMenuAction } from '@/lib/updateStatus'
import { notify } from '@/state'

export interface UpdateMenuHandlers {
  download(): void
  updateNow(): void
  check(): void
}

/** Runs the handler for `action`; returns false for `busy`, which ignores the choice so the caller can keep the menu open. */
export function runUpdateMenuAction(action: UpdateMenuAction, handlers: UpdateMenuHandlers): boolean {
  switch (action) {
    case 'busy':
      return false
    case 'download':
      handlers.download()
      return true
    case 'update-now':
      handlers.updateNow()
      return true
    case 'check':
      handlers.check()
      return true
  }
}

export function downloadUpdate(): Promise<void> {
  const id = toast.loading('Downloading update…')
  return window.refract.updates
    .install()
    .then((result) => {
      toast.dismiss(id)
      if (!result.ok) notify(result.error)
    })
    .catch(() => {
      toast.error('Could not download the update.', { id })
    })
}

export function checkForUpdates(): Promise<void> {
  const id = toast.loading('Checking for updates…')
  return window.refract.updates
    .check()
    .then((result) => {
      if (!result.ok) {
        toast.error(result.error.message, { id })
        return
      }
      const next = result.value
      if (next.phase === 'failed') {
        toast.error(next.lastError ?? 'Update failed for an unknown reason.', { id })
      } else if (next.phase === 'idle' && next.unavailableReason !== undefined) {
        toast.warning(updateUnavailableReasonText(next.unavailableReason), { id })
      } else if (next.phase === 'idle') {
        toast.info('Refract is up to date.', { id })
      } else if (next.phase === 'available') {
        toast.info(`Refract v${next.availableVersion} is available. Choose Download update in this menu.`, { id })
      } else if (next.phase === 'downloading') {
        toast.info('An update is already downloading.', { id })
      } else if (next.phase === 'downloaded') {
        toast.info(`Refract v${next.availableVersion} is downloaded; it installs the next time you quit.`, { id })
      } else if (next.phase === 'installing') {
        toast.info('Refract is installing the update.', { id })
      }
    })
    .catch(() => {
      toast.error('Could not check for updates.', { id })
    })
}
