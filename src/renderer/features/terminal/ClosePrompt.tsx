import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
import { useTerminalStore } from '@/state/terminal-store'
import type { TabInfo } from '../../../shared/ipc-terminal'
import { createCloseController, type FocusTarget } from './closeFlow'
import { focusStranded } from './terminalKeyboard'

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
  /** Closes now, or opens the prompt when the shell has a running job. `invoker` gets the keyboard back if the prompt is cancelled. */
  requestClose(tab: TabInfo, invoker?: FocusTarget | null): void
  /** The dialog; mount it once beside the tabs. */
  prompt: ReactNode
  /** The last close failure outside the dialog, for a quiet status line; `null` when none. */
  error: string | null
}

export function useCloseFlow(sessionId: string, restoreFocus: () => void): CloseFlow {
  // The panel passes a fresh function each render; the controller must not be rebuilt, or an open prompt would reset.
  const fallback = useRef(restoreFocus)
  useEffect(() => {
    fallback.current = restoreFocus
  })
  const controller = useMemo(
    () =>
      createCloseController({
        api: { close: (tabId, force) => window.refract.terminal.close(tabId, force) },
        removeTab: (tabId) => useTerminalStore.getState().removeTab(sessionId, tabId),
        fallbackFocus: () => fallback.current()
      }),
    [sessionId]
  )
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const handledCloses = useRef(0)

  // An idle close has no dialog to hand the keyboard back, and the tab or button that held it is gone.
  useEffect(() => {
    if (state.idleCloses === handledCloses.current) return
    handledCloses.current = state.idleCloses
    if (focusStranded(document)) controller.restoreFocus()
  }, [state.idleCloses, controller])

  const prompt = (
    <ClosePrompt tab={state.pending} busy={state.busy} error={state.pending ? state.error : null} restoreFocus={controller.restoreFocus} onCancel={controller.cancel} onConfirm={() => void controller.confirm()} />
  )
  return { requestClose: (tab, invoker) => void controller.requestClose(tab, invoker), prompt, error: state.pending ? null : state.error }
}
