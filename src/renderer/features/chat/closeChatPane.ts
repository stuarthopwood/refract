import { focusPaneContent, focusSessionRow, focusSessionsNav } from '@/lib/focus'
import { useSessionsStore, useSplitStore, useSubagentPanelStore } from '@/state'
import { STATUS_LABEL } from '@/features/sessions/sessionDisplay'
import { useChatAreaAnnouncer } from './chatAreaAnnouncer'

// Issue #621 (close chat pane): shared by ChatHeader's always-rendered close button
// (ChatPane.tsx) and App.tsx's Ctrl+W chord, so both routes to the same action behave
// identically -- same announcement, same focus fallback chain, same subagent-panel cleanup.
//
// `paneIndex` must still point at a real pane (`paneSessionIds[paneIndex]` defined) when this is
// called; both call sites only ever invoke it for a pane that is actually rendered right now.
export function closeChatPane(paneIndex: number): void {
  const { paneSessionIds } = useSplitStore.getState()
  const closedSessionId = paneSessionIds[paneIndex]
  if (closedSessionId === undefined) return

  const session = useSessionsStore.getState().sessions.find((s) => s.id === closedSessionId)
  const paneEl = document.querySelector<HTMLElement>(`[data-session-pane="${CSS.escape(closedSessionId)}"]`)
  const activeBefore = document.activeElement
  // Decision 9 (UX consult): only move focus for the last-pane-closed case when it was inside the
  // closed pane or on `<body>` -- otherwise wherever the user currently is (e.g. the session
  // list, mid-rename) must not be yanked away by a chord/click aimed at a different pane.
  const wasInsideClosedPaneOrBody = (paneEl?.contains(activeBefore) ?? false) || activeBefore === document.body

  // Decision: "On 1->0, close the Subagent panel if it is bound to this Session", mirroring the
  // FR-016 effect's own panel cleanup (ChatPane.tsx) for a Session that disappears entirely.
  // Scoped to the 1->0 transition only, per the decision -- a 2->1 split-close leaves the
  // survivor's own panel binding untouched.
  const closingLastPane = paneSessionIds.length === 1
  if (closingLastPane) {
    const panelState = useSubagentPanelStore.getState()
    if (panelState.sessionId === closedSessionId) panelState.closePanel({ restoreFocus: false })
  }

  useSplitStore.getState().closePane(paneIndex)

  if (session) {
    const suffix = session.status === 'working' ? ', still working' : session.status === 'needs-you' ? `, ${STATUS_LABEL['needs-you'].toLowerCase()}` : ''
    useChatAreaAnnouncer.getState().announce(`Closed ${session.name} chat pane${suffix}`)
  }

  requestAnimationFrame(() => {
    const remaining = useSplitStore.getState().paneSessionIds
    if (remaining.length > 0) {
      // Unchanged split-close behaviour (decision 8): the survivor becomes the sole pane and its
      // message box gets focus. The query that already did this before #621 still works: there
      // is now exactly one `[role="region"][aria-label$=" chat"]` pane in the DOM.
      focusPaneContent(document.querySelector<HTMLElement>('[role="region"][aria-label$=" chat"]'))
      return
    }
    if (!wasInsideClosedPaneOrBody) return
    if (focusSessionRow(closedSessionId)) return
    if (focusSessionsNav()) return
    document.querySelector<HTMLElement>('[data-chat-empty-state]')?.focus()
  })
}
