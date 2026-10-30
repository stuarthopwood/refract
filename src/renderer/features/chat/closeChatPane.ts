import { focusPaneContent, focusSessionRow, focusSessionsNav } from '@/lib/focus'
import { useSessionsStore, useSplitStore, useSubagentPanelStore } from '@/state'
import { STATUS_LABEL } from '@/features/sessions/sessionDisplay'
import { useChatAreaAnnouncer } from './chatAreaAnnouncer'

// `paneIndex` must still point at a rendered pane when called.
export function closeChatPane(paneIndex: number): void {
  const { paneSessionIds } = useSplitStore.getState()
  const closedSessionId = paneSessionIds[paneIndex]
  if (closedSessionId === undefined) return

  const session = useSessionsStore.getState().sessions.find((s) => s.id === closedSessionId)
  const paneEl = document.querySelector<HTMLElement>(`[data-session-pane="${CSS.escape(closedSessionId)}"]`)
  const activeBefore = document.activeElement
  const wasInsideClosedPaneOrBody = (paneEl?.contains(activeBefore) ?? false) || activeBefore === document.body

  const panelState = useSubagentPanelStore.getState()
  if (panelState.sessionId === closedSessionId) panelState.closePanel({ restoreFocus: false })

  useSplitStore.getState().closePane(paneIndex)

  if (session) {
    const suffix = session.status === 'working' ? ', still working' : session.status === 'needs-you' ? `, ${STATUS_LABEL['needs-you'].toLowerCase()}` : ''
    useChatAreaAnnouncer.getState().announce(`Closed ${session.name} chat pane${suffix}`)
  }

  requestAnimationFrame(() => {
    // The removed element's focus resolves to `<body>`, which the old guard missed.
    const active = document.activeElement
    const focusLost = active === null || active === document.body || !active.isConnected
    const remaining = useSplitStore.getState().paneSessionIds
    if (remaining.length > 0) {
      if (wasInsideClosedPaneOrBody || focusLost) {
        focusPaneContent(document.querySelector<HTMLElement>('[role="region"][aria-label$=" chat"]'))
      }
      return
    }
    if (!wasInsideClosedPaneOrBody && !focusLost) return
    if (focusSessionRow(closedSessionId)) return
    const nav = document.querySelector<HTMLElement>('nav[aria-label="Sessions"]')
    if (nav && !nav.closest('[inert]')) {
      nav.focus()
      return
    }
    const emptyState = document.querySelector<HTMLElement>('[data-chat-empty-state]')
    if (emptyState) {
      emptyState.focus()
      return
    }
    focusSessionsNav()
  })
}
