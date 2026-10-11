import { useRightPaneStore, useSubagentPanelStore } from '@/state'
import type { PanelId } from './panel-registry'

// Spec 013 (research.md decision 3): `right-pane-store.ts` never imports a hosted panel's own
// store, so the shell stays decoupled from any one panel's data. This is the one place that
// knows about both sides -- opening or closing a panel through a rail icon, a tab, a title-row
// Close button, or Delete also runs that panel's own binding/cleanup (today only `subagents` has
// one; a future panel with no store of its own falls through to the generic store call alone).

export function openHostedPanel(id: PanelId, sessionId: string | null): void {
  if (id === 'subagents' && sessionId) useSubagentPanelStore.getState().openPanel(sessionId)
  useRightPaneStore.getState().openPanel(id)
}

/** The explicit, user-driven close paths (title-row/tab Close button, Delete on a focused tab,
 * toggling an open-and-active rail icon off). `subagents` keeps its own existing `closePanel()`
 * unchanged (FR-015's regression guarantee): it clears the session binding, tells main to stop
 * forwarding the selected subagent's patches, keeps `right-pane-store.ts` in sync, and restores
 * focus to the Subagents chip exactly as it does on `main` today. A future panel with no store of
 * its own gets FR-024's generalised rule instead: if focus is left stranded once its own close
 * control vanishes, it moves to the rail button that opened it (mirroring the containment checks
 * `ChatPane.tsx`/`App.tsx` already use elsewhere in this codebase). */
export function closeHostedPanel(id: PanelId): void {
  if (id === 'subagents') {
    useSubagentPanelStore.getState().closePanel()
    return
  }
  useRightPaneStore.getState().closePanel(id)
  requestAnimationFrame(() => {
    const active = document.activeElement
    const stranded = !active || active === document.body || !active.isConnected
    if (stranded) document.querySelector<HTMLElement>(`[data-rail-button="${id}"]`)?.focus()
  })
}

/** A programmatic close that must never touch focus: dragging the pane fully shut, a new turn's
 * own per-turn reset, or the bound Session archiving/vanishing -- none of these are the user
 * clicking a close control, so none of them may steal focus from wherever it already is. */
export function closeHostedPanelSilently(id: PanelId): void {
  if (id === 'subagents') {
    useSubagentPanelStore.getState().closePanel({ restoreFocus: false })
    return
  }
  useRightPaneStore.getState().closePanel(id)
}

/** FR-005/FR-006: activating a panel's rail button opens it if it is not already the open,
 * active panel, and closes it (via the explicit-close path above) if it is. */
export function toggleHostedPanelFromRail(id: PanelId, sessionId: string | null): void {
  const { openPanelIds, activePanelId } = useRightPaneStore.getState()
  if (openPanelIds.includes(id) && activePanelId === id) closeHostedPanel(id)
  else openHostedPanel(id, sessionId)
}
