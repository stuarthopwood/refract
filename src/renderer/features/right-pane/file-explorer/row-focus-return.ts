import { frontActiveTab, useRightPaneStore } from '@/state/right-pane-store'
import { focusTook } from '../focus-took'
import { createOriginTracker } from '../focus-return-tracker'

/** Focuses the explorer row for `path`; false while the list has not mounted or measured it yet. */
export function focusExplorerRow(path: string): boolean {
  const row = document.querySelector<HTMLElement>(`[data-tree-row-path="${CSS.escape(path)}"]`)
  return row !== null && focusTook(row)
}

function explorerShowing(): boolean {
  const tab = frontActiveTab()
  return useRightPaneStore.getState().open && tab?.kind === 'panel' && tab.id === 'file-explorer'
}

const tracker = createOriginTracker({ isShowing: explorerShowing, focusTarget: (_sessionId, path) => focusExplorerRow(path) })

/** Remembers which explorer row opened a tab, so closing it can send focus back (FR-005). */
export function rememberRowOrigin(sessionId: string, tabId: string, path: string): void {
  tracker.remember(sessionId, tabId, path)
}

/** Forgets every origin and the store subscription; for tests. */
export const resetRowOrigins = tracker.reset
