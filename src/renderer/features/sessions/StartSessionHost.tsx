import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
import { openExistingSession, useStartSessionRequestStore } from './startSessionRequest'

/** "Open existing session" prompt shown when a Session already covers the issue or pull request (#1310). */
export function StartSessionHost() {
  const pending = useStartSessionRequestStore((s) => s.pending)
  const clear = useStartSessionRequestStore((s) => s.clear)
  const label = pending?.ref.kind === 'issue' ? 'issue' : 'pull request'

  return (
    <ConfirmAlertDialog
      open={pending !== null}
      busy={false}
      title="Open existing session?"
      description={`A session for this ${label} already exists: ${pending?.existing.name ?? ''}.`}
      confirmLabel="Open existing session"
      onCancel={clear}
      onConfirm={() => {
        if (pending) openExistingSession(pending.existing)
        clear()
      }}
      onCloseAutoFocus={() => false}
    />
  )
}
