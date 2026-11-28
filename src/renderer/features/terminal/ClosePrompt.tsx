import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
import { useTerminalStore } from '@/state/terminal-store'
import type { TabInfo } from '../../../shared/ipc-terminal'
import { closeTab } from './terminalTabs'

// Closing a tab ends its shell, so a tab with a running job asks first; an idle tab closes at once (spec 144 FR-012).

interface ClosePromptProps {
  tab: TabInfo | null
  busy: boolean
  error: string | null
  /** Moves focus back to the terminal once the prompt is gone, whichever way it closed. */
  restoreFocus(): void
  onCancel(): void
  onConfirm(): void
}

export function ClosePrompt({ tab, busy, error, restoreFocus, onCancel, onConfirm }: ClosePromptProps) {
  return (
    <ConfirmAlertDialog
      open={tab !== null}
      busy={busy}
      tone="destructive"
      title={`Close ${tab?.name ?? 'terminal'}?`}
      description="A command is still running in this terminal. Closing it stops the command and everything it started."
      confirmLabel="Close terminal"
      busyLabel="Closing"
      cancelLabel="Keep running"
      error={error}
      onCancel={onCancel}
      onConfirm={onConfirm}
      onCloseAutoFocus={() => {
        restoreFocus()
        return true
      }}
    />
  )
}

export interface CloseFlow {
  /** Closes now, or opens the prompt when the shell has a running job. */
  requestClose(tab: TabInfo): void
  /** The dialog; mount it once beside the tabs. */
  prompt: ReactNode
  /** The last close failure outside the dialog, for a quiet status line; `null` when none. */
  error: string | null
}

export function useCloseFlow(sessionId: string, restoreFocus: () => void): CloseFlow {
  const [pending, setPending] = useState<TabInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(
    async (tab: TabInfo, force: boolean) => {
      setBusy(true)
      setError(null)
      try {
        const outcome = await closeTab(window.refract.terminal, tab, force)
        if (outcome.kind === 'closed') {
          useTerminalStore.getState().removeTab(sessionId, tab.id)
          setPending(null)
        } else if (outcome.kind === 'confirm') {
          setPending(tab)
        } else {
          setError(outcome.message)
        }
      } finally {
        setBusy(false)
      }
    },
    [sessionId]
  )

  const prompt = (
    <ClosePrompt
      tab={pending}
      busy={busy}
      error={pending ? error : null}
      restoreFocus={restoreFocus}
      onCancel={() => {
        setPending(null)
        setError(null)
      }}
      onConfirm={() => pending && void run(pending, true)}
    />
  )
  return { requestClose: (tab) => void run(tab, false), prompt, error: pending ? null : error }
}
