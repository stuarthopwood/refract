import { useRightPaneStore, useSubagentPanelStore } from '@/state'
import type { PanelId } from './panel-registry'

// Spec 013 (research.md decision 3): `right-pane-store.ts` never imports a hosted panel's own
// store, so the shell stays decoupled from any one panel's data. This is the one place that
// knows about both sides -- opening, closing, suspending or resuming a panel through a rail icon,
// a tab, a title-row Close button, Delete, or a pane drag also runs that panel's own binding/
// cleanup (today only `subagents` has one; a future panel with no store of its own falls through
// to the generic store call alone).

export function openHostedPanel(
  id: PanelId,
  sessionId: string | null,
  options?: { selectSubagentId?: string; opener?: HTMLElement | null }
): void {
  if (id === 'subagents' && sessionId) useSubagentPanelStore.getState().openPanel(sessionId, options)
  // Issue #563 gate remediation: when the caller pre-selects an agent, `SubagentPanel.tsx`'s own
  // `pendingFocusSubagentId` effect (set above, inside `openPanel`) is the ONLY thing that
  // should move focus -- `right-pane-store.ts`'s own generic "focus the newly opened panel's
  // content" effect runs in the SAME commit as a genuine open and, left unsuppressed, steals
  // focus to its content wrapper a tick after this panel's own effect already landed it on the
  // pre-selected tree row (child effects run before parent effects). `focus: false` sets
  // `suppressNextContentFocus` (`RightPaneShell.tsx`'s own consuming effect), leaving that race
  // with only one winner.
  useRightPaneStore.getState().openPanel(id, { focus: !options?.selectSubagentId })
}

/** The explicit, user-driven close paths (title-row/tab Close button, Delete on a focused tab,
 * toggling an open-and-active rail icon off). `subagents` keeps its own existing `closePanel()`
 * unchanged (FR-015's regression guarantee): it clears the session binding, tells main to stop
 * forwarding the selected subagent's patches, keeps `right-pane-store.ts` in sync, and restores
 * focus to whichever control opened the panel THIS time (issue #563, FR-027) -- the Subagents
 * chip is only the fallback now, used whenever no opener was recorded or it has since left the
 * document, not a fixed first priority (FR-015's own regression guarantee is unaffected: nothing
 * else opened the panel before issue #563, so the chip was always that fallback in practice).
 * Gate remediation (FR-024, round 3): the chip is not always rendered (no subagents
 * this turn), so this generalises the fallback for every hosted panel: if focus is still
 * stranded afterwards (neither the opener nor the chip fired, or this isn't Subagents), it moves
 * to that panel's own rail button first, and only to the launcher's first row if the rail button
 * itself cannot be found (mirroring the containment checks `ChatPane.tsx`/`App.tsx` already use
 * elsewhere in this codebase).
 *
 * Gate remediation (PR2's own gate, round 1, High): `options.skipFocusFallback` lets a caller
 * that is ABOUT to move focus itself -- `PanelTabBar.tsx`'s `closeTab`, when one or more other
 * panels remain open -- suppress both this function's own rail/launcher fallback AND the chip
 * restore inside `subagent-store.ts`'s `closePanel`. Without it the two raced: the Subagents
 * chip's own restore runs SYNCHRONOUSLY inside `closePanel` (`subagent-store.ts`'s own
 * `document.activeElement`/`.focus()` check, no `requestAnimationFrame` involved there), so it
 * fired and moved focus to the chip before `closeTab`'s own `requestAnimationFrame` callback even
 * ran -- the tab bar's focus-the-neighbour call then landed a frame later, winning but only after
 * the chip had already visibly flashed focused first. Only the single-panel-close path (nothing
 * left to switch to) and the rail-toggle path (focus was never inside the pane to begin with)
 * still want this function's own fallback, so it stays the default. */
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
 * the pane is open AND this panel is open and active. `opener` (issue #563, FR-027) is only
 * relevant to the open branch -- a toggle-off close has no agent to pre-select, so nothing for
 * closing from this control's own button to specially record over the generic rail/launcher
 * fallback `closeHostedPanel` already applies. */
export function toggleHostedPanelFromRail(id: PanelId, sessionId: string | null, opener?: HTMLElement | null): void {
  const { open, openPanelIds, activePanelId } = useRightPaneStore.getState()
  if (open && openPanelIds.includes(id) && activePanelId === id) closeHostedPanel(id)
  else openHostedPanel(id, sessionId, { opener })
}
