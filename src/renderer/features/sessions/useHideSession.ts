// Issue #748: Hide / Unhide a Session. Shared by the Session list row and the Manage sessions row
// so both offer the identical behaviour: no confirm dialog, a "Hid <name>" toast with Undo, and
// focus that never lands on a row that just left the list.
import { toast } from 'sonner'
import { focusSessionRow } from '@/lib/focus'
import { useSessionListStore, useSessionsStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'

interface HideSessionOptions {
  /** Captures the nearest surviving row before the call, for when this row leaves the list. */
  captureFocusFallback(): void
  /** Focuses this row's own control; used when the row stays (Show hidden on) and after Undo. */
  focusRow(): void
  onAnnounce?(message: string): void
}

export function useHideSession(session: SessionSummary, options: HideSessionOptions) {
  const setHidden = useSessionsStore((state) => state.setHidden)

  function unhide(): void {
    void setHidden(session.id, false).then((ok) => {
      if (!ok) return
      options.onAnnounce?.(`Unhid ${session.name}`)
      requestAnimationFrame(() => focusSessionRow(session.id))
    })
  }

  function hide(): void {
    // With Show hidden on the row survives, so focus stays on it; otherwise it leaves the list.
    if (useSessionListStore.getState().showHidden) options.focusRow()
    else options.captureFocusFallback()
    void setHidden(session.id, true).then((ok) => {
      if (!ok) return
      toast(`Hid ${session.name}`, { duration: 10000, action: { label: 'Undo', onClick: unhide } })
    })
  }

  return { hide, unhide }
}
