import { useAgentAnnouncementStore } from '@/state/agent-announcement-store'
import { useDocumentTabsStore, type CloseResult } from '@/state/document-tabs-store'
import { useRightPaneStore } from '@/state/right-pane-store'

export type BulkCloseAction = 'others' | 'all' | 'stale'

const SCOPE: Record<BulkCloseAction, string> = { others: 'other', all: 'file and diff', stale: 'no-longer-changed' }

/** "Closed 3 other tabs": every bulk close says how many tabs it took (FR-029). */
export function bulkCloseAnnouncement(action: BulkCloseAction, count: number): string {
  return `Closed ${count} ${SCOPE[action]} ${count === 1 ? 'tab' : 'tabs'}`
}

/** The store repoints a Session's active document; the pane's live selection follows it here. */
export function applyCloseResult(sessionId: string, result: CloseResult): void {
  if (!result.activeChanged) return
  const { activePanelId, activateTab } = useRightPaneStore.getState()
  const target = result.next ?? (activePanelId ? { kind: 'panel' as const, id: activePanelId } : null)
  if (target) activateTab(target, sessionId)
  else useRightPaneStore.setState({ activeTabKey: null })
}

export function runBulkClose(sessionId: string, action: BulkCloseAction, keepId: string | null): void {
  const documents = useDocumentTabsStore.getState()
  const result = action === 'others' ? (keepId ? documents.closeOthers(sessionId, keepId) : null) : action === 'all' ? documents.closeAllDocuments(sessionId) : documents.closeDead(sessionId)
  if (!result || result.closed.length === 0) return
  applyCloseResult(sessionId, result)
  useAgentAnnouncementStore.getState().announce(bulkCloseAnnouncement(action, result.closed.length))
}
