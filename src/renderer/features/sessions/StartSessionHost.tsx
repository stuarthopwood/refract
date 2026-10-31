import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
import { focusSessionPane } from '@/lib/focus'
import { openExistingSession, startSessionNow, useStartSessionRequestStore } from './startSessionRequest'

/** Prompts for the two cases that need a decision before a Session starts from an issue or pull request: an existing Session, or a fork (#1310). */
export function StartSessionHost() {
  const pending = useStartSessionRequestStore((s) => s.pending)
  const clear = useStartSessionRequestStore((s) => s.clear)

  if (pending?.kind === 'fork') {
    return (
      <ConfirmAlertDialog
        open
        busy={false}
        size="md"
        title="Start a Session on untrusted code?"
        description={
          <>
            <span className="block">
              This pull request may come from a fork{pending.owner ? ` owned by ${pending.owner}` : ''}, not this project's GitHub repository.
            </span>
            <span className="mt-2 block">
              Its branch may contain code, commit messages, or an AGENTS.md written by someone you don't control, which an agent session would then read and could act on.
            </span>
            <span className="mt-2 block">Only continue if you trust this pull request's author.</span>
          </>
        }
        confirmLabel="Start Session anyway"
        onCancel={clear}
        onConfirm={() => {
          const { ref } = pending
          clear()
          void startSessionNow(ref)
        }}
        onCloseAutoFocus={() => false}
      />
    )
  }

  const label = pending?.ref.kind === 'issue' ? 'issue' : 'pull request'
  return (
    <ConfirmAlertDialog
      open={pending !== null}
      busy={false}
      title="Open existing session?"
      description={`A session for this ${label} already exists: ${pending?.kind === 'existing' ? pending.existing.name : ''}.`}
      confirmLabel="Open existing session"
      onCancel={clear}
      onConfirm={() => {
        if (pending?.kind !== 'existing') return
        const { existing } = pending
        openExistingSession(existing)
        clear()
        requestAnimationFrame(() => focusSessionPane(existing.id))
      }}
      onCloseAutoFocus={() => false}
    />
  )
}