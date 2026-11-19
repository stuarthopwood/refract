import { useDocumentTabsStore } from '@/state/document-tabs-store'
import type { GitChangesGroupKind } from '../../../shared/model'
import { GitDiffView } from '../right-pane/git-changes/GitDiffView'
import { usePathActionHandlers } from './usePathActionHandlers'

interface DiffTabViewProps {
  sessionId: string
  tabId: string
  group: GitChangesGroupKind
  path: string
}

/** A diff tab: the shared diff view with this tab's own scroll position and the same path actions a file tab has. */
export function DiffTabView({ sessionId, tabId, group, path }: DiffTabViewProps) {
  const scrollTop = useDocumentTabsStore((s) => s.bySession[sessionId]?.view[tabId]?.scrollTop)
  const actions = usePathActionHandlers(sessionId)
  return (
    <GitDiffView
      sessionId={sessionId}
      group={group}
      path={path}
      scrollTop={scrollTop}
      {...actions}
      onScrollTopChange={(next) => useDocumentTabsStore.getState().setViewState(sessionId, tabId, { scrollTop: next })}
    />
  )
}
