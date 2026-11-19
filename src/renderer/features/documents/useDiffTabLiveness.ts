import { useEffect } from 'react'
import { useGitChangesStore } from '@/state'
import { useDocumentTabsStore, type DocumentTab } from '@/state/document-tabs-store'
import { useDiffTabRetarget } from '../right-pane/git-changes/useDiffTabRetarget'
import { useGitChangesWatch } from '../right-pane/git-changes/useGitChangesWatch'
import { syncDiffTabLiveness } from './diff-liveness'

const NO_TABS: DocumentTab[] = []

/**
 * A diff tab that is not active has no mounted view, so its view cannot notice the file left every group (#2075 FR-012).
 * The shell runs this for the whole Session: it holds the watcher, keeps the snapshot loaded, and moves or kills every open diff tab.
 */
export function useDiffTabLiveness(sessionId: string | null): void {
  const tabs = useDocumentTabsStore((s) => (sessionId ? s.bySession[sessionId]?.tabs : undefined)) ?? NO_TABS
  const hasDiffTab = tabs.some((tab) => tab.kind === 'diff')
  const snapshot = useGitChangesStore((s) => (sessionId ? (s.bySession[sessionId]?.snapshot ?? null) : null))

  useGitChangesWatch(hasDiffTab ? sessionId : null)
  useEffect(() => {
    if (hasDiffTab && sessionId) void useGitChangesStore.getState().load(sessionId)
  }, [hasDiffTab, sessionId])
  useDiffTabRetarget(hasDiffTab ? sessionId : null, snapshot)
  useEffect(() => {
    if (sessionId && snapshot) syncDiffTabLiveness(sessionId, snapshot)
  }, [sessionId, snapshot, tabs])
}
