import { useDocumentTabsStore } from '@/state/document-tabs-store'
import type { GitChangesGroupKind } from '../../../shared/model'
import { GitDiffView } from '../right-pane/git-changes/GitDiffView'

interface DiffTabViewProps {
  sessionId: string
  tabId: string
  group: GitChangesGroupKind
  path: string
}

/** A diff tab: the shared diff view with this tab's own scroll position. */
export function DiffTabView({ sessionId, tabId, group, path }: DiffTabViewProps) {
  const scrollTop = useDocumentTabsStore((s) => s.bySession[sessionId]?.view[tabId]?.scrollTop)
  return (
    <GitDiffView
      sessionId={sessionId}
      group={group}
      path={path}
      scrollTop={scrollTop}
      onScrollTopChange={(next) => useDocumentTabsStore.getState().setViewState(sessionId, tabId, { scrollTop: next })}
    />
  )
}
