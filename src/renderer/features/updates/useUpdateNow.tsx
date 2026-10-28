// "Update now" (issue #883, FR-035): restart and install the downloaded update. Shared by the
// sidebar notice row and the footer badge popover. With any live agent it asks first
// (restarting stops them); with none it goes straight through.
import { useState } from 'react'
import type { ReactNode } from 'react'
import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
import { notify, useSessionsStore } from '@/state'

// Quitting stops every live agent (any status but `stopped`), not just the mid-turn ones.
function liveAgentCount(): number {
  return useSessionsStore.getState().sessions.filter((session) => session.status !== 'stopped' && !session.archivedAt).length
}

export function useUpdateNow(restoreFocus: () => void): { requestUpdateNow(): void; confirmDialog: ReactNode } {
  // Fixed when the confirm opens; kept after close so the text does not change mid-animation.
  const [count, setCount] = useState(0)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  async function installNow(): Promise<void> {
    setBusy(true)
    const result = await window.refract.updates.installNow()
    setBusy(false)
    setOpen(false)
    if (!result.ok) notify(result.error)
  }

  const requestUpdateNow = (): void => {
    const live = liveAgentCount()
    if (live > 0) {
      setCount(live)
      setOpen(true)
    } else void installNow()
  }

  const confirmDialog = (
    <ConfirmAlertDialog
      open={open}
      busy={busy}
      title="Restart and update?"
      description={`${count} ${count === 1 ? 'agent is' : 'agents are'} running; restarting stops ${count === 1 ? 'it' : 'them'}.`}
      confirmLabel="Restart and update"
      busyLabel="Restarting…"
      onCancel={() => setOpen(false)}
      onConfirm={() => void installNow()}
      onCloseAutoFocus={restoreFocus}
    />
  )
  return { requestUpdateNow, confirmDialog }
}
