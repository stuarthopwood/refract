import { useDocumentTabsStore } from '@/state/document-tabs-store'
import { frontActiveTab, useRightPaneStore } from '@/state/right-pane-store'

export type FocusLocation = 'body' | 'tab-strip' | 'other'

// The explorer is unmounted while a document tab is active, so the row a tab came from is tracked here, not in the panel.
const origins = new Map<string, string>()
let watching = false

type TabsBySession = Record<string, { tabs: readonly { id: string }[] } | undefined>

/** Removes every remembered origin whose tab is gone and returns those whose Session still exists; a deleted Session has no row to return to. */
export function takeClosedOrigins(map: Map<string, string>, bySession: TabsBySession): { sessionId: string; path: string }[] {
  const closed: { sessionId: string; path: string }[] = []
  for (const [key, path] of [...map]) {
    const cut = key.indexOf('\n')
    const sessionId = key.slice(0, cut)
    const documents = bySession[sessionId]
    if (documents?.tabs.some((tab) => tab.id === key.slice(cut + 1))) continue
    map.delete(key)
    if (documents) closed.push({ sessionId, path })
  }
  return closed
}

/** Focus goes back to the row only when the explorer is showing and focus was lost to the closed tab (body) or sits on the strip; a Ctrl+click open keeps focus on the list, so a later eviction never steals it. */
export function shouldReturnFocusToRow(explorerShowing: boolean, focus: FocusLocation): boolean {
  return explorerShowing && focus !== 'other'
}

function focusLocation(): FocusLocation {
  const active = document.activeElement
  if (!active || active === document.body) return 'body'
  return active.closest('[role="tablist"]') ? 'tab-strip' : 'other'
}

function explorerShowing(): boolean {
  const tab = frontActiveTab()
  return useRightPaneStore.getState().open && tab?.kind === 'panel' && tab.id === 'file-explorer'
}

function returnFocus(path: string): void {
  // Two frames: the strip's own focus move after a close runs in the next one, and the explorer mounts with the row selected.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (!shouldReturnFocusToRow(explorerShowing(), focusLocation())) return
      document.querySelector<HTMLElement>(`[data-tree-row-path="${CSS.escape(path)}"]`)?.focus()
    })
  )
}

/** Remembers which explorer row opened a tab, so closing it can send focus back (FR-005). */
export function rememberRowOrigin(sessionId: string, tabId: string, path: string): void {
  origins.set(`${sessionId}\n${tabId}`, path)
  if (watching) return
  watching = true
  useDocumentTabsStore.subscribe((state) => {
    for (const closed of takeClosedOrigins(origins, state.bySession)) returnFocus(closed.path)
  })
}
