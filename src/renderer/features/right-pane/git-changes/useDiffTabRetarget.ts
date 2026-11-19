import { useEffect } from 'react'
import { documentTabId, useDocumentTabsStore } from '@/state/document-tabs-store'
import type { GitChangesSnapshot } from '../../../../shared/model'
import { planDiffRetargets } from './diff-retarget'
import { moveDiffOrigin } from './diff-row-focus-return'

/** Stage and unstage land here as a snapshot change, so a bulk action or the row menu moves open diff tabs the same way (FR-030). */
export function useDiffTabRetarget(sessionId: string | null, snapshot: GitChangesSnapshot | null): void {
  useEffect(() => {
    if (!sessionId || !snapshot) return
    const store = useDocumentTabsStore.getState()
    for (const { id, group, to, path } of planDiffRetargets(store.bySession[sessionId]?.tabs ?? [], snapshot.groups)) {
      // The rename would otherwise read as a close and pull focus back to the row, so the origin moves first.
      const toId = documentTabId({ kind: 'diff', group: to, path })
      moveDiffOrigin(sessionId, id, toId, to)
      if (!store.retargetDiff(sessionId, id, to)) moveDiffOrigin(sessionId, toId, id, group)
    }
  }, [sessionId, snapshot])
}
