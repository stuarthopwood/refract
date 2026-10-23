// "Update now" (issue #883, FR-035): restart and install the downloaded update. Shared by the
// sidebar notice row and the footer badge popover. With any agent mid-turn it asks first
// (restarting stops them); with none it goes straight through.
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
import { notify, useSessionsStore } from '@/state'

function runningAgentCount(): number {
  return useSessionsStore.getState().sessions.filter((session) => session.status === 'working' && !session.archivedAt).length
}

export function useUpdateNow(restoreFocus: () => void): { requestUpdateNow(): void; confirmDialog: ReactNode } {
  const [runningCount, setRunningCount] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const lastCountRef = useRef(0)
  if (runningCount !== null) lastCountRef.current = runningCount

  async function installNow(): Promise<void> {
    setBusy(true)
    const result = await window.refract.updates.installNow()
    setBusy(false)
    setRunningCount(null)
    if (!result.ok) notify(result.error)
  }

  const requestUpdateNow = (): void => {
    const count = runningAgentCount()
    if (count > 0) setRunningCount(count)
    else void installNow()
  }

  const count = lastCountRef.current
  const confirmDialog = (
    <ConfirmAlertDialog
      open={runningCount !== null}
      busy={busy}
      title="Restart and update?"
      description={`${count} ${count === 1 ? 'agent is' : 'agents are'} running; restarting stops ${count === 1 ? 'it' : 'them'}.`}
      confirmLabel="Restart and update"
      busyLabel="Restarting…"
      onCancel={() => setRunningCount(null)}
      onConfirm={() => void installNow()}
      onCloseAutoFocus={restoreFocus}
    />
  )
  return { requestUpdateNow, confirmDialog }
}
