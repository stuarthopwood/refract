import { useRightPaneStore, useSubagentPanelStore } from '@/state'
import type { PanelId } from './panel-registry'


export function openHostedPanel(
  id: PanelId,
  sessionId: string | null,
  options?: { selectSubagentId?: string; selectSubagentKey?: string; opener?: HTMLElement | null }
): void {
  if (id === 'subagents' && sessionId) useSubagentPanelStore.getState().openPanel(sessionId, options)
  useRightPaneStore.getState().openPanel(id, { focus: !options?.selectSubagentId })
}

/** The explicit, user-driven close paths (title-row/tab Close button, Delete on a focused tab, */
export function closeHostedPanel(id: PanelId, options?: { skipFocusFallback?: boolean }): void {
  const panelEl = document.getElementById('right-pane-active-panel')
  const wasInside = panelEl?.contains(document.activeElement) ?? false
  if (id === 'subagents') {
    useSubagentPanelStore.getState().closePanel({ restoreFocus: !options?.skipFocusFallback })
  } else {
    useRightPaneStore.getState().closePanel(id)
  }
  if (options?.skipFocusFallback) return
  if (!wasInside) return
  requestAnimationFrame(() => {
    const active = document.activeElement
    const stranded = !active || active === document.body || !active.isConnected
    if (!stranded) return
    const target =
      document.querySelector<HTMLElement>(`[data-rail-button="${id}"]`) ??
      document.querySelector<HTMLElement>('[data-panel-launcher] button')
    target?.focus()
  })
}

/** Dragging the pane fully shut (spec 013 gate remediation, Critical/High): */
export function suspendHostedPanels(ids: readonly PanelId[]): void {
  if (ids.includes('subagents')) useSubagentPanelStore.getState().suspend()
}

/** The counterpart to `suspendHostedPanels`, called when the pane is dragged back open with the */
export function resumeHostedPanels(ids: readonly PanelId[]): void {
  if (ids.includes('subagents')) useSubagentPanelStore.getState().resume()
}

/** FR-005/FR-006: */
export function toggleHostedPanelFromRail(id: PanelId, sessionId: string | null, opener?: HTMLElement | null): void {
  const { open, openPanelIds, activePanelId } = useRightPaneStore.getState()
  if (open && openPanelIds.includes(id) && activePanelId === id) closeHostedPanel(id)
  else openHostedPanel(id, sessionId, { opener })
}
