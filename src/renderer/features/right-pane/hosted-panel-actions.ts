import { useRightPaneStore, useSubagentPanelStore } from '@/state'
import type { PanelId } from './panel-registry'

// Spec 013 (research.md decision 3): `right-pane-store.ts` never imports a hosted panel's own
// store, so the shell stays decoupled from any one panel's data. This is the one place that
// knows about both sides -- opening, closing, suspending or resuming a panel through a rail icon,
// a tab, a title-row Close button, Delete, or a pane drag also runs that panel's own binding/
// cleanup (today only `subagents` has one; a future panel with no store of its own falls through
// to the generic store call alone).

export function openHostedPanel(id: PanelId, sessionId: string | null): void {
  if (id === 'subagents' && sessionId) useSubagentPanelStore.getState().openPanel(sessionId)
  useRightPaneStore.getState().openPanel(id)
}

/** The explicit, user-driven close paths (title-row/tab Close button, Delete on a focused tab,
 * toggling an open-and-active rail icon off). `subagents` keeps its own existing `closePanel()`
 * unchanged (FR-015's regression guarantee): it clears the session binding, tells main to stop
 * forwarding the selected subagent's patches, keeps `right-pane-store.ts` in sync, and restores
 * focus to the Subagents chip when that chip is what had focus. Gate remediation (High, FR-024):
 * the chip is not always rendered (no subagents this turn), so this generalises the fallback --
 * if focus is still stranded afterwards, it moves to the rail button, or to the launcher's first
 * row once this was the last open panel (mirroring the containment checks `ChatPane.tsx`/
 * `App.tsx` already use elsewhere in this codebase). */
export function closeHostedPanel(id: PanelId): void {
  const panelEl = document.getElementById('right-pane-active-panel')
  const wasInside = panelEl?.contains(document.activeElement) ?? false
  if (id === 'subagents') {
    useSubagentPanelStore.getState().closePanel()
  } else {
    useRightPaneStore.getState().closePanel(id)
  }
  if (!wasInside) return
  requestAnimationFrame(() => {
    const active = document.activeElement
    const stranded = !active || active === document.body || !active.isConnected
    if (!stranded) return
    const { openPanelIds } = useRightPaneStore.getState()
    const target =
      openPanelIds.length === 0
        ? document.querySelector<HTMLElement>('[data-panel-launcher] button')
        : document.querySelector<HTMLElement>(`[data-rail-button="${id}"]`)
    target?.focus()
  })
}

/** Dragging the pane fully shut (spec 013 gate remediation, Critical/High): FR-003 and the
 * data-model.md collapsed-pane invariant both say collapsing the pane is a separate action from
 * closing a panel -- the open panels and their Session bindings survive. Only the live stream
 * stops, since nothing can see it while the pane is 0px wide. */
export function suspendHostedPanels(ids: readonly PanelId[]): void {
  if (ids.includes('subagents')) useSubagentPanelStore.getState().suspend()
}

/** The counterpart to `suspendHostedPanels`, called when the pane is dragged back open with the
 * same panels still bound. */
export function resumeHostedPanels(ids: readonly PanelId[]): void {
  if (ids.includes('subagents')) useSubagentPanelStore.getState().resume()
}

/** FR-005/FR-006: activating a panel's rail button opens it if the pane is collapsed, or it is
 * not already the open, active panel; it closes it (via the explicit-close path above) only when
 * the pane is open AND this panel is open and active. */
export function toggleHostedPanelFromRail(id: PanelId, sessionId: string | null): void {
  const { open, openPanelIds, activePanelId } = useRightPaneStore.getState()
  if (open && openPanelIds.includes(id) && activePanelId === id) closeHostedPanel(id)
  else openHostedPanel(id, sessionId)
}
