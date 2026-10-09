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

  // Decision: "On 1->0, close the Subagent panel if it is bound to this Session". Quality-gate
  // remediation (code-reviewer, MEDIUM, PR #634): generalised to every close, not just 1->0 --
  // `SessionManager.ts` drops subagent patches for a Session once it is no longer visible, so a
  // panel left bound to a session whose pane just closed (the 2->1 case too) would freeze on
  // stale data rather than simply closing.
  const panelState = useSubagentPanelStore.getState()
  if (panelState.sessionId === closedSessionId) panelState.closePanel({ restoreFocus: false })

  useSplitStore.getState().closePane(paneIndex)

  if (session) {
    const suffix = session.status === 'working' ? ', still working' : session.status === 'needs-you' ? `, ${STATUS_LABEL['needs-you'].toLowerCase()}` : ''
    useChatAreaAnnouncer.getState().announce(`Closed ${session.name} chat pane${suffix}`)
  }

  requestAnimationFrame(() => {
    // Quality-gate remediation (accessibility-auditor, HIGH, PR #634): `wasInsideClosedPaneOrBody`
    // alone misses two real cases -- Ctrl+W pressed while focus was in the Subagent panel bound
    // to this Session (closed above with `restoreFocus:false`, unmounting its own content), or in
    // a Radix overlay portalled outside the pane (ConversationSwitcher's history Dialog, an
    // ApprovalModePill menu) that unmounts along with ChatPane. Neither starts inside
    // `[data-session-pane]` or on `<body>`, so the old guard left focus exactly where the
    // removed element used to be -- which the DOM already resolves to `<body>` by the time this
    // frame runs. Treating THAT as equally eligible for the focus chain (rather than only a
    // pre-emptively captured `<body>`) covers both without naming the panel or every overlay.
    const active = document.activeElement
    const focusLost = active === null || active === document.body || !active.isConnected
    const remaining = useSplitStore.getState().paneSessionIds
    if (remaining.length > 0) {
      // Unchanged split-close behaviour (decision 8) -- but quality-gate remediation
      // (accessibility-auditor, MEDIUM, PR #634): only when focus was actually eligible to move.
      // Before #621 this branch only ran from the in-pane close button, so focus was always
      // inside the closed pane; Ctrl+W can now fire from the session list (mid-rename), the
      // Subagent panel, or the status bar, and must not yank focus into the survivor from there.
      if (wasInsideClosedPaneOrBody || focusLost) {
        focusPaneContent(document.querySelector<HTMLElement>('[role="region"][aria-label$=" chat"]'))
      }
      return
    }
    if (!wasInsideClosedPaneOrBody && !focusLost) return
    if (focusSessionRow(closedSessionId)) return
    // Quality-gate remediation (accessibility-auditor, LOW, PR #634): `focusSessionsNav()` falls
    // back to the session list's own resize handle when the nav is inert, which always succeeds
    // -- so the empty-state container below was never actually reached. Checking the real,
    // reachable nav directly first (decision 9's own middle step) lets the empty-state container
    // be decision 9's genuine last step; `focusSessionsNav()` remains a final defensive fallback
    // for the one case neither target exists in the DOM.
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
