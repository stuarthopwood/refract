import { useDocumentTabsStore, type DocumentTab } from '@/state/document-tabs-store'
import type { GitChangesSnapshot } from '../../../shared/model'
import { isNoLongerChanged } from '../right-pane/git-changes/git-diff-state'

export interface DeadMark {
  id: string
  dead: boolean
}

/** A diff tab is dead once no group holds its file; it revives if the file is changed again. Only a loaded snapshot can say so. */
export function planDeadMarks(tabs: readonly DocumentTab[], snapshot: GitChangesSnapshot | null | undefined): DeadMark[] {
  const marks: DeadMark[] = []
  for (const tab of tabs) {
    if (tab.kind !== 'diff') continue
    const dead = isNoLongerChanged(snapshot, tab.path)
    if (dead !== tab.dead) marks.push({ id: tab.id, dead })
  }
  return marks
}

export function syncDiffTabLiveness(sessionId: string, snapshot: GitChangesSnapshot | null | undefined): void {
  const store = useDocumentTabsStore.getState()
  for (const { id, dead } of planDeadMarks(store.bySession[sessionId]?.tabs ?? [], snapshot)) store.markDead(sessionId, id, dead)
}
